import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { loadCredentials } from '../auth/credentials.js';
import { getHookPath } from '../hook/installer.js';
import { log, debug } from '../log.js';

export type BridgeStatus = 'running' | 'stopped' | 'error' | 'connecting';
export type HookConfigStatus = 'enabled' | 'installed_only' | 'not_found';

export interface BridgeState {
  bridge: BridgeStatus;
  relay: 'connected' | 'connecting' | 'disconnected';
  hookInstalled: boolean;
  hookConfig: HookConfigStatus;
  mpOnline: boolean;
}

type Listener = (state: BridgeState) => void;

/**
 * Singleton service that tracks bridge process and hook config status.
 */
export class BridgeStatusService {
  private static _instance: BridgeStatusService;
  private static _extensionPath = '';

  /** Required capabilities for a bridge to be adoptable. */
  private static readonly REQUIRED_CAPS = ['register-window', 'window-id', 'session-label', 'approval_forward', 'activate-session', 'deactivate-session'];

  private _process: ChildProcess | null = null;
  private _myPid: number | null = null;
  private _port = 3001;
  private _state: BridgeState = { bridge: 'stopped', relay: 'disconnected', hookInstalled: false, hookConfig: 'not_found', mpOnline: false };
  private _listeners = new Set<Listener>();
  private _healthTimer?: ReturnType<typeof setInterval>;
  private _startedAt = 0;
  private _windowRegistered = false;

  static getInstance(): BridgeStatusService {
    if (!BridgeStatusService._instance) {
      BridgeStatusService._instance = new BridgeStatusService();
    }
    return BridgeStatusService._instance;
  }

  /** Tell the service where the extension lives (needed to find dist/bridge-entry.js). */
  static setExtensionPath(fsPath: string): void {
    BridgeStatusService._extensionPath = fsPath;
  }

  /** Get the previously set extension path. */
  static getExtensionPath(): string {
    return BridgeStatusService._extensionPath;
  }

  get state(): BridgeState {
    const hookInstalled = isHookInstalledSafe();
    const hookConfig = readHookConfigStatus();
    return { ...this._state, hookInstalled, hookConfig };
  }

  /** Port the bridge is listening on (default 3001, auto-assigned if occupied). */
  getBridgePort(): number {
    return this._port;
  }

  /** Full bridge base URL (e.g. http://127.0.0.1:3001). */
  getBridgeUrl(): string {
    return `http://127.0.0.1:${this._port}`;
  }

  onDidChange(listener: Listener): vscode.Disposable {
    this._listeners.add(listener);
    return { dispose: () => { this._listeners.delete(listener); } };
  }

  /** Idempotent — only starts if not already running. Call from sidebar, startClaudeCode, enableHook. */
  ensureStarted(): void {
    if (this._process || this._state.bridge === 'running' || this._state.bridge === 'connecting') return;
    this.start();
  }

  /** Start the bridge child process. */
  start(): void {
    if (this._process || this._state.bridge === 'connecting') return;

    this._startedAt = Date.now();
    this._update({ bridge: 'connecting' });

    this._tryAdoptOrSpawn();
  }

  /** Try to adopt an orphaned bridge; if none found or incompatible, spawn bundled. */
  private async _tryAdoptOrSpawn(): Promise<void> {
    // Check for existing bridge on the default port
    try {
      const resp = await fetch(`${this.getBridgeUrl()}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        const body = await resp.json() as { source?: string; supports?: string[]; startedAt?: number };
        const source = body.source ?? '';
        const supports = body.supports ?? [];

        if (BridgeStatusService.REQUIRED_CAPS.every(c => supports.includes(c))) {
          // Check if bridge is stale (started before current build)
          const buildTime = this._getBuildTime();
          const bridgeStartedAt = body.startedAt ?? 0;
          if (buildTime > 0 && bridgeStartedAt > 0 && bridgeStartedAt < buildTime) {
            log(`[CodeKey] stale bridge detected (bridgeStartedAt=${bridgeStartedAt} < buildTime=${buildTime}), replacing`);
            this._forceKillBridgeOnPort();
            // Fall through to spawn bundled
          } else {
            // Compatible bridge — adopt it
            log(`[CodeKey] adopted existing bridge (source=${source})`);
            this._startHealthCheck();
            return;
          }
        } else {
          // Incompatible version — warn user to close it manually, never auto-kill external bridges
          log(`[CodeKey] incompatible bridge detected (source=${source}), supports=${JSON.stringify(supports)}`);
          await vscode.window.showWarningMessage(
            `An incompatible CodeKey bridge is already running on port ${this._port}. Please close it first (Ctrl+C in the terminal) so the extension can start its bundled bridge.`,
          );
          this._update({ bridge: 'error' });
          return;
        }
      }
    } catch { /* no orphan */ }

    // Spawn bundled bridge
    this._spawnBundled();
  }

  private _spawnBundled(): void {
    const bridgeEntry = path.join(BridgeStatusService._extensionPath, 'dist', 'bridge-entry.cjs');
    if (!fs.existsSync(bridgeEntry)) {
      log(`[CodeKey] bridge-entry.js not found at ${bridgeEntry}`);
      this._update({ bridge: 'error' });
      return;
    }

    const creds = loadCredentials();
    if (!creds?.deviceId || !creds?.deviceSecret) {
      log('[CodeKey] no credentials — bridge not started, waiting for pair');
      this._update({ bridge: 'stopped' });
      return;
    }

    const args = [
      bridgeEntry,
      '--device-id', creds.deviceId,
    ];
    if (!creds.deviceToken) {
      args.push('--pairing');
    }

    log(`[CodeKey] spawning bundled bridge: ${process.execPath} ${bridgeEntry} --device-id ${creds.deviceId}${creds.deviceToken ? '' : ' --pairing'}`);

    const proc = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CODEKEY_DEVICE_TOKEN: creds.deviceToken ?? creds.deviceSecret,
        CODEKEY_RELAY_URL: creds.relayUrl,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
      },
    });

    this._process = proc;
    this._myPid = proc.pid ?? null;

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (!text) return;
      // Parse port auto-assignment from bridge output
      const portMatch = text.match(/BRIDGE_PORT=(\d+)/);
      if (portMatch) {
        this._port = Number(portMatch[1]);
        log(`[CodeKey] bridge port: ${this._port}`);
      }
      debug(`[CodeKey] bridge: ${text}`);
    });

    proc.on('exit', (code) => {
      if (this._process !== proc) return;
      this._process = null;
      this._myPid = null;
      this._stopHealthCheck();
      this._startedAt = 0;
      if (code !== 0) log(`[CodeKey] bridge exited with code ${code}`);
      this._update({ bridge: code === 0 ? 'stopped' : 'error' });
    });

    proc.on('error', (err) => {
      if (this._process !== proc) return;
      this._process = null;
      this._myPid = null;
      this._stopHealthCheck();
      this._startedAt = 0;
      log(`[CodeKey] bridge spawn error: ${err.message}`);
      this._update({ bridge: 'error' });
    });

    this._startHealthCheck();
  }

  /** Stop the bridge process. Tries graceful /v1/shutdown first, falls back to force-kill. */
  async stop(): Promise<void> {
    // Try graceful shutdown first
    try {
      const windowId = process.env.CODEKEY_WINDOW_ID || '';
      await fetch(`${this.getBridgeUrl()}/v1/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId }),
        signal: AbortSignal.timeout(3000),
      });
      this._process = null;
      this._myPid = null;
      this._stopHealthCheck();
      this._update({ bridge: 'stopped' });
      return;
    } catch {
      log('[CodeKey] graceful shutdown failed, falling back to kill');
    }

    // Kill owned process by handle
    if (this._process) {
      this._process.kill();
      this._process = null;
      this._myPid = null;
      this._stopHealthCheck();
      this._update({ bridge: 'stopped' });
      return;
    }

    // Adopted bridge: force-kill by port
    this._forceKillBridgeOnPort();
    this._stopHealthCheck();
    this._update({ bridge: 'stopped' });
  }

  /** Get the mtime of the bundled bridge-entry.cjs (our build timestamp). */
  private _getBuildTime(): number {
    try {
      const p = path.join(BridgeStatusService._extensionPath, 'dist', 'bridge-entry.cjs');
      return fs.statSync(p).mtimeMs;
    } catch {
      return 0;
    }
  }

  /** Force-kill any process listening on the bridge port. */
  private _forceKillBridgeOnPort(): void {
    const port = this._port;
    try {
      if (process.platform === 'win32') {
        const out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf-8', timeout: 5000 });
        const lines = out.trim().split(/\r?\n/);
        const killed = new Set<string>();
        for (const line of lines) {
          const m = line.match(/(\d+)\s*$/);
          if (m && m[1] && !killed.has(m[1])) {
            const pid = m[1];
            killed.add(pid);
            log(`[CodeKey] force-killing bridge on port ${port} (PID=${pid})`);
            execSync(`taskkill /F /PID ${pid}`, { encoding: 'utf-8', timeout: 5000 });
          }
        }
      } else {
        execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null; true`, { timeout: 5000 });
      }
    } catch {
      // Process may already be gone
    }
  }

  restart(): void {
    this.stop().then(() => this.ensureStarted());
  }

  dispose(): void {
    this.stop();
    this._forceKillBridgeOnPort();
    this._listeners.clear();
  }

  private _update(partial: Partial<BridgeState>): void {
    this._state = { ...this._state, ...partial };
    for (const listener of this._listeners) {
      listener(this._state);
    }
  }

  private async _checkHealth(): Promise<void> {
    const GRACE_MS = 8000;
    try {
      const resp = await fetch(`${this.getBridgeUrl()}/v1/health`);
      if (resp.ok) {
        const body = await resp.json() as { relay?: string; mpOnline?: boolean };
        const relay = (body.relay ?? 'disconnected') as BridgeState['relay'];
        const updates: Partial<BridgeState> = { bridge: 'running', relay };
        if (this._state.bridge !== 'running') {
          this._update(updates);
        } else if (this._state.relay !== relay) {
          this._update({ relay });
        }
        if (!this._windowRegistered) {
          this._windowRegistered = true;
          fetch(`${this.getBridgeUrl()}/v1/register-window`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId: process.env.CODEKEY_WINDOW_ID || '' }),
          }).catch(() => {});
        }
      } else if (Date.now() - this._startedAt > GRACE_MS) {
        this._update({ bridge: 'error' });
      }
    } catch {
      if (Date.now() - this._startedAt > GRACE_MS && this._state.bridge !== 'stopped') {
        this._update({ bridge: this._process ? 'error' : 'stopped' });
      }
    }
  }

  private _startHealthCheck(): void {
    this._stopHealthCheck();
    this._checkHealth();
    this._healthTimer = setInterval(() => this._checkHealth(), 10_000);
  }

  private _stopHealthCheck(): void {
    if (this._healthTimer) {
      clearInterval(this._healthTimer);
      this._healthTimer = undefined;
    }
  }
}

function isHookInstalledSafe(): boolean {
  try {
    const dir = getHookPath();
    if (!fs.existsSync(dir)) return false;
    const files = ['claude_code_permission_request.js', 'claude_code_stop.js', 'claude_code_notification.js'];
    return files.some(f => fs.existsSync(path.join(dir, f)));
  } catch { return false; }
}

function readHookConfigStatus(): HookConfigStatus {
  try {
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
    const raw = fs.readFileSync(settingsPath, 'utf-8');
    const settings = JSON.parse(raw);
    const pr = settings.hooks?.PermissionRequest;
    if (!Array.isArray(pr) || pr.length === 0) return 'installed_only';
    const hasCodeKey = pr.some((entry: unknown) => {
      const cmd = (entry as { hooks?: { command?: string }[] })?.hooks?.[0]?.command ?? '';
      return cmd.includes('claude_code_permission_request.js');
    });
    return hasCodeKey ? 'enabled' : 'installed_only';
  } catch {
    return 'not_found';
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}
