import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { findCli } from '../cli.js';
import { loadCredentials } from '../auth/credentials.js';
import { getHookPath } from '../hook/installer.js';
import { log } from '../log.js';

export type BridgeStatus = 'running' | 'stopped' | 'error' | 'connecting';
export type HookConfigStatus = 'enabled' | 'installed_only' | 'not_found';

export interface BridgeState {
  bridge: BridgeStatus;
  hookInstalled: boolean;
  hookConfig: HookConfigStatus;
}

type Listener = (state: BridgeState) => void;

/**
 * Singleton service that tracks bridge process and hook config status.
 * enable-hook.ts writes (start/stop), sidebar provider reads (polling display).
 */
export class BridgeStatusService {
  private static _instance: BridgeStatusService;
  private _process: ChildProcess | null = null;
  private _state: BridgeState = { bridge: 'stopped', hookInstalled: false, hookConfig: 'not_found' };
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

  get state(): BridgeState {
    const hookInstalled = isHookInstalledSafe();
    const hookConfig = readHookConfigStatus();
    return { ...this._state, hookInstalled, hookConfig };
  }

  onDidChange(listener: Listener): vscode.Disposable {
    this._listeners.add(listener);
    return { dispose: () => { this._listeners.delete(listener); } };
  }

  /** Start the bridge child process. Throws if CLI cannot be found. */
  start(): void {
    if (this._process) return;

    this._startedAt = Date.now();
    this._update({ bridge: 'connecting' });

    // Check if an orphaned bridge from a previous session is still alive.
    // If so, adopt it instead of spawning a new one (avoids EADDRINUSE).
    this._tryAdoptOrSpawn();
  }

  /** Try to adopt an orphaned bridge; if none found, spawn a new one. */
  private async _tryAdoptOrSpawn(): Promise<void> {
    try {
      const resp = await fetch('http://127.0.0.1:3001/v1/health', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) {
        log('[CodeKey] orphaned bridge alive — adopting');
        this._startHealthCheck();
        return;
      }
    } catch { /* no orphan */ }

    // No orphan — spawn fresh
    const cliPath = findCli();
    if (!cliPath) {
      log('[CodeKey] bridge: findCli() returned null — no bridge binary found');
      this._update({ bridge: 'error' });
      return;
    }

    log(`[CodeKey] bridge: spawning ${cliPath}`);
    const creds = loadCredentials();
    const args = creds?.relayUrl ? ['bridge', '--relay', creds.relayUrl] : ['bridge'];

    const proc = spawn(cliPath, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: process.platform === 'win32' && cliPath.endsWith('.cmd'),
    });

    this._process = proc;

    proc.stderr?.on('data', (chunk: Buffer) => {
      const lines = chunk.toString().trimEnd();
      if (lines) log(`[CodeKey] bridge: ${lines}`);
    });

    proc.on('exit', (code) => {
      if (this._process !== proc) return; // stale
      this._process = null;
      this._stopHealthCheck();
      this._startedAt = 0;
      if (code !== 0) log(`[CodeKey] bridge exited with code ${code}`);
      this._update({ bridge: 'stopped' });
    });

    proc.on('error', (err) => {
      if (this._process !== proc) return; // stale
      this._process = null;
      this._stopHealthCheck();
      this._startedAt = 0;
      log(`[CodeKey] bridge spawn error: ${err.message}`);
      this._update({ bridge: 'stopped' });
    });

    this._startHealthCheck();
  }

  /** Stop the bridge child process */
  stop(): void {
    if (!this._process) return;
    this._process.kill(); // SIGTERM on Unix, terminates on Windows
    this._process = null;
    this._stopHealthCheck();
    this._update({ bridge: 'stopped' });
  }

  restart(): void {
    this.stop();
    this.start();
  }

  dispose(): void {
    this.stop();
    this._listeners.clear();
  }

  private _update(partial: Partial<BridgeState>): void {
    this._state = { ...this._state, ...partial };
    for (const listener of this._listeners) {
      listener(this._state);
    }
  }

  private async _checkHealth(): Promise<void> {
    const GRACE_MS = 8000; // ignore transient errors shortly after start
    try {
      const resp = await fetch('http://127.0.0.1:3001/v1/health');
      if (resp.ok) {
        if (this._state.bridge !== 'running') {
          this._update({ bridge: 'running' });
        }
        // Register this VSCode window with the bridge so hook events from this
        // window can be associated with the correct windowId.
        if (!this._windowRegistered) {
          this._windowRegistered = true;
          fetch('http://127.0.0.1:3001/v1/register-window', {
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
        this._update({ bridge: 'stopped' });
      }
    }
  }

  private _startHealthCheck(): void {
    this._stopHealthCheck();
    // Check immediately, then every 10s
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

/** True if at least one CodeKey hook script exists in ~/.claude/hooks/ */
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
