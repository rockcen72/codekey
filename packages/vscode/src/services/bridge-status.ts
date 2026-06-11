import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, execSync, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { resolveCodexBinaryForVSCode } from './codex-binary-resolver.js';
import { loadCredentials, clearCredentials } from '../auth/credentials.js';
import { getHookPath } from '../hook/installer.js';
import { log, debug } from '../log.js';
import { listPidsByPort, killPid } from '@codekey/shared/bridge';

export type BridgeStatus = 'running' | 'stopped' | 'error' | 'connecting';
export type HookConfigStatus = 'enabled' | 'installed_only' | 'not_found';
export type AgentIntegrationStatus = 'enabled' | 'not_found';

export interface BridgeState {
  bridge: BridgeStatus;
  relay: 'connected' | 'connecting' | 'disconnected';
  hookInstalled: boolean;
  hookConfig: HookConfigStatus;
  codexHook: AgentIntegrationStatus;
  opencodePlugin: AgentIntegrationStatus;
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
  private _state: BridgeState = { bridge: 'stopped', relay: 'disconnected', hookInstalled: false, hookConfig: 'not_found', codexHook: 'not_found', opencodePlugin: 'not_found', mpOnline: false };
  private _listeners = new Set<Listener>();
  private _healthTimer?: ReturnType<typeof setInterval>;
  private _startedAt = 0;
  private _windowRegistered = false;
  private _healthInFlight = false;
  private _healthFailures = 0;
  private _adoptedSource: string | null = null;

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
    const codexHook: AgentIntegrationStatus = isCodexHookInstalledSafe() ? 'enabled' : 'not_found';
    const opencodePlugin: AgentIntegrationStatus = isOpenCodePluginInstalledSafe() ? 'enabled' : 'not_found';
    return { ...this._state, hookInstalled, hookConfig, codexHook, opencodePlugin };
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
            this._adoptedSource = source;
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
    this._healthFailures = 0;
    this._adoptedSource = null;
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
    if (!creds.deviceToken) {
      log('[CodeKey] no device token — bridge not started, waiting for pair');
      this._update({ bridge: 'stopped' });
      return;
    }

    const args = [
      bridgeEntry,
      '--device-id', creds.deviceId,
    ];

    const bridgeCodexPath = resolveCodexBinaryForVSCode(BridgeStatusService._extensionPath);
		log(`[CodeKey] spawning bundled bridge: ${process.execPath} ${bridgeEntry} --device-id ${creds.deviceId}`);

    const proc = spawn(process.execPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        CODEKEY_DEVICE_TOKEN: creds.deviceToken,
        CODEKEY_RELAY_URL: creds.relayUrl,
        NODE_TLS_REJECT_UNAUTHORIZED: '0',
        ...(bridgeCodexPath ? { CODEX_BINARY_PATH: bridgeCodexPath } : {}),
      },
    });

    this._process = proc;
    this._myPid = proc.pid ?? null;

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trimEnd();
      if (!text) return;
      const portMatch = text.match(/BRIDGE_PORT=(\d+)/);
      if (portMatch) {
        this._port = Number(portMatch[1]);
        log(`[CodeKey] bridge port: ${this._port}`);
        return;
      }
      // 检测 AUTH_FAILED 标记
      const authFailedMatch = text.match(/AUTH_FAILED=(.+)/);
      if (authFailedMatch) {
        const code = authFailedMatch[1];
        log(`[CodeKey] bridge auth_failed: ${code}`);
        clearCredentials();
        this._update({ bridge: 'stopped' });
        this._stopHealthCheck();
        if (code === 'DEVICE_REPLACED') {
          vscode.window.showWarningMessage(
            'CodeKey: 此设备已被新设备替换，请重新配对。',
          );
        } else {
          vscode.window.showInformationMessage(
            `CodeKey: 设备已解绑 (${code})。`,
          );
        }
        return;
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
      if (this._healthFailures >= 3) {
        log('[CodeKey] restarting bundled bridge after health-check failure');
        this._update({ bridge: 'connecting' });
        this._spawnBundled();
        return;
      }
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

  /** Stop the bridge process. Tries graceful /v1/shutdown first.
   *  With force=true, replace the bridge even if it reports active windows. */
  async stop(options: { force?: boolean } = {}): Promise<void> {
    // Try graceful shutdown first
    try {
      const windowId = process.env.CODEKEY_WINDOW_ID || '';
      const resp = await fetch(`${this.getBridgeUrl()}/v1/shutdown`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ windowId }),
        signal: AbortSignal.timeout(3000),
      });
      if (resp.ok) {
        this._process = null;
        this._myPid = null;
        this._stopHealthCheck();
        this._update({ bridge: 'stopped' });
        return;
      }
      const msg = await resp.text().catch(() => '');
      log(`[CodeKey] graceful shutdown refused (${resp.status})${msg ? `: ${msg}` : ''}`);
      if (!options.force) return;
    } catch {
      log('[CodeKey] graceful shutdown failed');
      if (!options.force && !this._process) return;
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
    if (!options.force) return;
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
    const pids = listPidsByPort(this._port);
    for (const pid of pids) {
      log(`[CodeKey] force-killing bridge on port ${this._port} (PID=${pid})`);
      killPid(pid);
    }
  }

  restart(): void {
    this.stop({ force: true }).then(() => this.ensureStarted());
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
    if (this._healthInFlight) return;
    this._healthInFlight = true;
    try {
      const resp = await fetch(`${this.getBridgeUrl()}/v1/health`, { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        this._healthFailures = 0;
        const body = await resp.json() as { relay?: string; mpOnline?: boolean };
        const relay = (body.relay ?? 'disconnected') as BridgeState['relay'];
        const mpOnline = body.mpOnline ?? false;
        const updates: Partial<BridgeState> = { bridge: 'running', relay, mpOnline };
        if (this._state.bridge !== 'running') {
          this._update(updates);
        } else if (this._state.relay !== relay || this._state.mpOnline !== mpOnline) {
          this._update({ relay, mpOnline });
        }
        if (!this._windowRegistered) {
          this._windowRegistered = true;
          fetch(`${this.getBridgeUrl()}/v1/register-window`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ windowId: process.env.CODEKEY_WINDOW_ID || '' }),
            signal: AbortSignal.timeout(2000),
          }).catch(() => {});
        }
      } else if (Date.now() - this._startedAt > GRACE_MS) {
        this._update({ bridge: 'error' });
      }
    } catch {
      this._healthFailures++;
      if (Date.now() - this._startedAt > GRACE_MS && this._state.bridge !== 'stopped') {
        this._update({ bridge: this._process ? 'error' : 'stopped' });
      }
      if (!this._process && this._adoptedSource === 'vscode-bundled' && this._healthFailures >= 3) {
        log('[CodeKey] adopted bundled bridge disappeared after reload, spawning a fresh bundled bridge');
        this._update({ bridge: 'connecting', relay: 'disconnected' });
        this._spawnBundled();
        return;
      }
      if (this._process && this._healthFailures >= 3) {
        log('[CodeKey] bridge health check timed out repeatedly, restarting bundled bridge');
        this._process.kill();
      }
    } finally {
      this._healthInFlight = false;
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

function isCodexHookInstalledSafe(): boolean {
  try {
    // Check if script file exists (the canonical indicator)
    const scriptPath = path.join(os.homedir(), '.codex', 'codex_permission_request.js');
    if (fs.existsSync(scriptPath)) return true;
    // Fallback: check hooks.json config
    const hooksPath = path.join(os.homedir(), '.codex', 'hooks.json');
    if (!fs.existsSync(hooksPath)) return false;
    const raw = fs.readFileSync(hooksPath, 'utf-8');
    return raw.includes('codex_permission_request.js');
  } catch { return false; }
}

function isOpenCodePluginInstalledSafe(): boolean {
  try {
    const pluginPath = path.join(os.homedir(), '.config', 'opencode', 'plugins', 'codekey-telemetry.js');
    return fs.existsSync(pluginPath);
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
