import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn } from 'node:child_process';
import * as vscode from 'vscode';
import { classifyTerminal } from '../commands/start-claude.js';
import { findCli } from '../cli.js';
import { log, debug } from '../log.js';
import { BridgeStatusService } from './bridge-status.js';
import { whichBinary, binaryName, needsShellForScript } from '@codekey/shared/bridge';

// Phone → PC command latency budget: a user pushing a command on the
// mini program expects a near-instant reaction. Poll at 200ms so the
// average pickup latency is ~100ms (vs ~1000ms at POLL_MS=2000). The
// bridge is local-only and the queue is normally empty, so the extra
// traffic is negligible (~5 requests/sec per VS Code window).
const POLL_MS = 200;
const RESUME_TERMINAL_INITIAL_SEND_DELAY_MS = 1200;

/**
 * Polls the bridge for pending commands from the phone.
 * Sends them to the trusted Claude Code terminal (strict-match only).
 * If no trusted terminal exists, commands stay in the queue.
 */
export class CommandRelayService {
  private static _instance?: CommandRelayService;
  static instance(): CommandRelayService | undefined { return this._instance; }

  private _timer?: ReturnType<typeof setInterval>;
  /** The trusted Claude Code terminal we write phone commands into */
  private _terminal?: vscode.Terminal;
  /** Resume terminals keyed by claudeSessionId for tab mode */
  private _resumeTerminals = new Map<string, vscode.Terminal>();
  private _disposed = false;

  constructor() {
    CommandRelayService._instance = this;
  }

  start(): void {
    this._poll();
    this._timer = setInterval(() => this._poll(), POLL_MS);
  }

  stop(): void {
    this._disposed = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
    // Close all resume terminals
    for (const [sid, term] of this._resumeTerminals) {
      term.dispose();
    }
    this._resumeTerminals.clear();
  }

  /**
   * Called when the user launches Claude Code from the sidebar.
   * Stores the terminal ref so command-relay can write to it.
   */
  setTerminal(term: vscode.Terminal): void {
    this._terminal = term;
  }

  /** Return claudeSessionIds of all active resume terminals. */
  getActiveResumeSessionIds(): string[] {
    const ids: string[] = [];
    for (const [sid, term] of this._resumeTerminals) {
      if (vscode.window.terminals.includes(term)) {
        ids.push(sid);
      } else {
        this._resumeTerminals.delete(sid);
      }
    }
    return ids;
  }

  /** Return whether a managed terminal is currently active. */
  hasManagedTerminal(): boolean {
    return !!(this._terminal && vscode.window.terminals.includes(this._terminal));
  }

  /** Find a Claude Code binary.
   *  1. codekey CLI
   *  2. Global claude on PATH (supports --resume with user's sessions)
   *  3. CC extension bundled binary (does NOT support --resume)
   */
  private _findClaudeBinary(): { path: string; args: string[] } | null {
    const cliPath = findCli();
    if (cliPath) return { path: cliPath, args: ['claude'] };

    // Global claude on PATH — has access to user's session transcripts
    const claudePath = whichBinary('claude');
    if (claudePath) return { path: claudePath, args: [] };

    // CC extension bundled binary — fallback only (no --resume support)
    const ccExt = vscode.extensions.getExtension('anthropic.claude-code');
    if (ccExt) {
      const exeName = binaryName('claude');
      const binaryPath = path.join(ccExt.extensionUri.fsPath, 'resources', 'native-binary', exeName);
      try {
        if (fs.existsSync(binaryPath)) return { path: binaryPath, args: [] };
      } catch { /* ignore */ }
    }

    return null;
  }

  /**
   * Execute a command via CC in one-shot --print mode.
   * CC resumes the session, processes the prompt, prints output, and exits.
   * The Stop hook fires on exit, generating task_complete for the mini program.
   * Returns a Promise that resolves when CC exits (or rejects on spawn error).
   */
  private _executeCommand(
    sessionId: string,
    text: string,
    binary: { path: string; args: string[] },
    cwd?: string,
  ): Promise<{ code: number | null; stderr: string; durationMs: number }> {
    const startMs = Date.now();
    return new Promise((resolve, reject) => {
      try {
        log('[command-relay] spawning CC --resume %s --print %s cwd=%s', sessionId.slice(0, 8), text.slice(0, 40), cwd ?? '(default)');
        // Phone-pushed commands use --resume --print so the session is
        // synchronous (process and exit). We must bypass the permission
        // prompt because the --print mode does not invoke the
        // PermissionRequest hook, which would otherwise block on the
        // phone approval flow. The user already authorised the command
        // by pushing it from the mini program.
        //
        // SCOPE: This bypass applies ONLY to phone-pushed commands routed
        // through _executeCommand. The user's interactive CC running in a
        // managed VS Code terminal is unaffected — that path uses
        // term.sendText() above and goes through the full PermissionRequest
        // hook → phone approval flow.
        const child = spawn(binary.path, [...binary.args, '--resume', sessionId, '--print', text, '--permission-mode', 'bypassPermissions'], {
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
          shell: needsShellForScript(binary.path),
          cwd,
        });
        let stdout = '';
        let stderr = '';
        child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
        child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
        child.on('exit', (code) => {
          const dur = Date.now() - startMs;
          log('[command-relay] CC --print session=%s exited code=%d dur=%dms stdout=%s stderr=%s',
            sessionId.slice(0, 8), code, dur, stdout.slice(0, 200), stderr.slice(0, 200));
          resolve({ code, stderr, durationMs: dur });
        });
        child.on('error', (err) => {
          log('[command-relay] CC --print spawn error: %s', err.message);
          reject(err);
        });
      } catch (err) {
        log('[command-relay] CC --print failed: %s', String(err));
        reject(err);
      }
    });
  }

  private _inFlightSpawns = new Map<string, Promise<void>>();

  /** Post an error event to the bridge so the phone sees a clear failure message. */
  private async _reportCommandError(
    serverSessionId: string,
    claudeSessionId: string,
    result: { code: number | null; stderr: string; durationMs: number },
  ): Promise<void> {
    try {
      const message = `CC exited with code ${result.code} (${result.durationMs}ms)`;
      log('[command-relay] %s session=%s', message, claudeSessionId.slice(0, 8));
      await fetch(`${BridgeStatusService.getInstance().getBridgeUrl()}/v1/session-error`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: serverSessionId,
          agent: 'claude-code-hook',
          message: result.stderr ? `${message}: ${result.stderr.slice(0, 300)}` : message,
        }),
      });
    } catch {
      // bridge may be gone — the failure is already logged above
    }
  }

  private async _poll(): Promise<void> {
    if (this._disposed) return;

    try {
      const resp = await fetch(`${BridgeStatusService.getInstance().getBridgeUrl()}/v1/pending-commands`);
      if (!resp.ok) return;
      const commands = await resp.json() as { id: string; sessionId?: string; claudeSessionId?: string; cwd?: string; text: string }[];
      if (commands.length === 0) return;

      // Fetch resumed Codex session IDs so we can skip their commands
      let codexSessionIds = new Set<string>();
      try {
        const codexResp = await fetch(`${BridgeStatusService.getInstance().getBridgeUrl()}/v1/codex-sessions/resumed-ids`);
        if (codexResp.ok) {
          const { ids } = await codexResp.json() as { ids: string[] };
          codexSessionIds = new Set(ids ?? []);
        }
      } catch { /* bridge unreachable, skip filtering */ }

      const term = this._findManagedTerminal();
      const claudeBinary = term ? null : this._findClaudeBinary();
      debug('[command-relay] _poll: commands=%d term=%s claudeBinary=%s', commands.length, !!term, !!claudeBinary);
      debug('[command-relay] terminals:', vscode.window.terminals.map(t => ({ name: t.name, exitStatus: t.exitStatus })));
      const deliverable = commands.filter(c => {
        // Skip Codex and OpenCode sessions — handled by their own managers
        if (c.claudeSessionId && codexSessionIds.has(c.claudeSessionId)) return false;
        if (c.claudeSessionId && /^ses_/.test(c.claudeSessionId)) return false;
        return term || !!(claudeBinary && c.claudeSessionId);
      });
      if (deliverable.length === 0) {
        debug('[command-relay] no deliverable target, command_ids=%s', commands.map(c => c.id).join(','));
        return;
      }

      const ids = deliverable.map(c => c.id);
      const claimResp = await fetch(`${BridgeStatusService.getInstance().getBridgeUrl()}/v1/pending-commands/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!claimResp.ok) return;
      const claimed = await claimResp.json() as { id: string; sessionId?: string; claudeSessionId?: string; cwd?: string; text: string }[];

      for (const cmd of claimed) {
        log('[command-relay] dispatch: claudeSessionId=%s text=%s term=%s', cmd.claudeSessionId ?? '(none)', cmd.text.slice(0, 60), !!term);
        if (term) {
          // Terminal mode: sendText to managed terminal (used when the user
          // already has an interactive CC running they want to interleave with).
          term.sendText(cmd.text, true);
        } else if (claudeBinary && cmd.claudeSessionId) {
          // First phone prompt stays on stable --print. After it completes, we
          // prewarm a hidden interactive resume terminal so later prompts can
          // skip cold spawn + transcript-load cost without risking first-input loss.
          const key = cmd.sessionId || cmd.claudeSessionId;
          const previous = this._inFlightSpawns.get(key) ?? Promise.resolve();
          const task = previous.then(async () => {
            if (this._hasActiveResumeTerminal(cmd.claudeSessionId!)) {
              await this._sendToResumeTerminal(cmd.sessionId || cmd.claudeSessionId || '', cmd.claudeSessionId!, cmd.text, cmd.cwd, claudeBinary);
              return;
            }
            await this._executeCommand(cmd.claudeSessionId!, cmd.text, claudeBinary, cmd.cwd).then((result) => {
              if (result.code !== 0) {
                this._reportCommandError(cmd.sessionId || cmd.claudeSessionId || '', cmd.claudeSessionId!, result);
              } else {
                this._prewarmResumeTerminal(cmd.claudeSessionId!, cmd.cwd, claudeBinary);
              }
            }).catch((err) => {
              this._reportCommandError(cmd.sessionId || cmd.claudeSessionId || '', cmd.claudeSessionId!, { code: -1, stderr: String(err), durationMs: 0 });
            });
          }).catch((err) => {
            this._reportCommandError(cmd.sessionId || cmd.claudeSessionId || '', cmd.claudeSessionId!, { code: -1, stderr: String(err), durationMs: 0 });
          });
          const tracked = task.finally(() => {
            if (this._inFlightSpawns.get(key) === tracked) this._inFlightSpawns.delete(key);
          });
          this._inFlightSpawns.set(key, tracked);
        }
      }
    } catch {
      // bridge not reachable — skip this cycle
    }
  }

  private _hasActiveResumeTerminal(sessionId: string): boolean {
    const term = this._resumeTerminals.get(sessionId);
    if (term && vscode.window.terminals.includes(term)) return true;
    if (term) this._resumeTerminals.delete(sessionId);
    return false;
  }

  private _prewarmResumeTerminal(
    sessionId: string,
    cwd: string | undefined,
    binary: { path: string; args: string[] },
  ): void {
    if (this._hasActiveResumeTerminal(sessionId)) return;
    log('[command-relay] prewarming resume terminal for session=%s', sessionId.slice(0, 8));
    const term = vscode.window.createTerminal({
      name: `CodeKey: ${sessionId.slice(0, 8)}`,
      cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath,
      shellPath: binary.path,
      shellArgs: [...binary.args, '--resume', sessionId],
      env: { CODEKEY_WINDOW_ID: vscode.env.sessionId },
      hideFromUser: true,
    });
    this._resumeTerminals.set(sessionId, term);

    const closeListener = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === term) {
        this._resumeTerminals.delete(sessionId);
        closeListener.dispose();
      }
    });
  }

  /** Find the trusted Claude Code terminal. Stored ref first, then strict-name scan. */
  private _findManagedTerminal(): vscode.Terminal | undefined {
    if (this._terminal && vscode.window.terminals.includes(this._terminal)) {
      return this._terminal;
    }
    // Strict-match only — fuzzy matches require explicit user confirmation
    for (const t of vscode.window.terminals) {
      const r = classifyTerminal(t);
      if (r.matched && r.matched !== 'fuzzy') {
        this._terminal = t;
        return t;
      }
    }
    this._terminal = undefined;
    return undefined;
  }

  /**
   * Send a prompt to CC via a hidden VS Code Terminal + sendText.
   * VS Code Terminal provides a real TTY → CC runs in interactive mode →
   * PermissionRequest hooks fire for tool approvals (unlike pipe stdin which
   * makes CC skip approval hooks entirely).
   *
   * The terminal is created once per claudeSessionId and reused for subsequent
   * commands (CC stays in interactive mode waiting for input).
   */
  private _sendToResumeTerminal(
    serverSessionId: string,
    sessionId: string,
    text: string,
    cwd: string | undefined,
    binary: { path: string; args: string[] },
  ): Promise<void> {
    // Reuse existing terminal for this session
    let term = this._resumeTerminals.get(sessionId);
    if (term && !vscode.window.terminals.includes(term)) {
      log('[command-relay] resume terminal for session=%s was closed externally, cleaning up', sessionId.slice(0, 8));
      this._resumeTerminals.delete(sessionId);
      term = undefined;
    }

    const isNewTerminal = !term;
    log('[command-relay] _sendToResumeTerminal: sessionId=%s (len=%d) isNew=%s',
      sessionId, sessionId.length, isNewTerminal);
    if (!term) {
      log('[command-relay] creating resume terminal for session=%s binary=%s cwd=%s',
        sessionId.slice(0, 8), binary.path, cwd ?? '(default)');
      term = vscode.window.createTerminal({
        name: `CodeKey: ${sessionId.slice(0, 8)}`,
        cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath,
        shellPath: binary.path,
        shellArgs: [...binary.args, '--resume', sessionId],
        env: { CODEKEY_WINDOW_ID: vscode.env.sessionId },
        hideFromUser: true,
      });
      this._resumeTerminals.set(sessionId, term);

      // Clean up on terminal close
      const closeListener = vscode.window.onDidCloseTerminal((closed) => {
        if (closed === term) {
          this._resumeTerminals.delete(sessionId);
          closeListener.dispose();
        }
      });
    }

    if (isNewTerminal) {
      // Give CC time to load the session transcript and enter its read loop
      // before writing the first command. Keeping this short makes the first
      // mobile prompt feel responsive while still avoiding lost input.
      log('[command-relay] new terminal, delaying sendText by %dms for session=%s',
        RESUME_TERMINAL_INITIAL_SEND_DELAY_MS, sessionId.slice(0, 8));
      return new Promise((resolve) => {
        setTimeout(() => {
        if (!term || !vscode.window.terminals.includes(term)) {
          log('[command-relay] sendText ABORT: terminal for session=%s no longer exists', sessionId.slice(0, 8));
          this._reportCommandError(serverSessionId, sessionId, { code: -1, stderr: 'Claude resume terminal disappeared before prompt delivery', durationMs: RESUME_TERMINAL_INITIAL_SEND_DELAY_MS });
          resolve();
          return;
        }
        log('[command-relay] sendText → terminal: session=%s text=%s (terminal state=%s exitStatus=%s)',
          sessionId.slice(0, 8), text.slice(0, 60),
          term.state, JSON.stringify(term.exitStatus));
        term.sendText(text, true);
        resolve();
        // If the CC process exited (e.g. --resume failed), surface the failure.
        setTimeout(() => {
          if (!vscode.window.terminals.includes(term)) {
            log('[command-relay] POST-CHECK: terminal for session=%s is GONE (CC exited? data may have been lost)', sessionId.slice(0, 8));
            this._reportCommandError(serverSessionId, sessionId, { code: -1, stderr: 'Claude resume terminal exited after prompt delivery', durationMs: 2000 });
          } else {
            log('[command-relay] POST-CHECK: terminal for session=%s still alive (state=%s)', sessionId.slice(0, 8), term.state);
          }
        }, 2000);
        }, RESUME_TERMINAL_INITIAL_SEND_DELAY_MS);
      });
    } else {
      log('[command-relay] sendText → terminal: session=%s text=%s (terminal state=%s exitStatus=%s)',
        sessionId.slice(0, 8), text.slice(0, 60),
        term!.state, JSON.stringify(term!.exitStatus));
      term!.sendText(text, true);
      return Promise.resolve();
    }
  }

  dispose(): void {
    this.stop();
  }
}
