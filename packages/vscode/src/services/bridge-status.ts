import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn, type ChildProcess } from 'node:child_process';
import * as vscode from 'vscode';
import { findCli } from '../cli.js';
import { getHookPath } from '../hook/installer.js';

export type BridgeStatus = 'running' | 'stopped' | 'error';
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

    const cliPath = findCli();
    if (!cliPath) throw new Error('codekey CLI not found — is it installed and on PATH?');

    this._process = spawn(cliPath, ['bridge'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      shell: process.platform === 'win32' && cliPath.endsWith('.cmd'),
    });

    this._process.on('exit', (code) => {
      this._process = null;
      this._update({ bridge: code === 0 ? 'stopped' : 'error' });
    });

    // Don't mark 'running' until first health check succeeds
    this._startHealthCheck();
  }

  /** Stop the bridge child process */
  stop(): void {
    if (!this._process) return;
    this._process.kill('SIGINT');
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
    try {
      const resp = await fetch('http://127.0.0.1:3001/v1/health');
      if (resp.ok) {
        if (this._state.bridge !== 'running') {
          this._update({ bridge: 'running' });
        }
      } else {
        this._update({ bridge: 'error' });
      }
    } catch {
      if (this._state.bridge !== 'stopped') {
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
