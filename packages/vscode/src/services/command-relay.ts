import * as path from 'node:path';
import * as fs from 'node:fs';
import { execSync } from 'node:child_process';
import * as vscode from 'vscode';
import { classifyTerminal } from '../commands/start-claude.js';
import { findCli } from '../cli.js';

const POLL_MS = 2000;
const BRIDGE_URL = 'http://127.0.0.1:3001';

/**
 * Polls the bridge for pending commands from the phone.
 * Sends them to the trusted Claude Code terminal (strict-match only).
 * If no trusted terminal exists, commands stay in the queue.
 */
export class CommandRelayService {
  private _timer?: ReturnType<typeof setInterval>;
  /** The trusted Claude Code terminal we write phone commands into */
  private _terminal?: vscode.Terminal;
  /** Resume terminals keyed by claudeSessionId for tab mode */
  private _resumeTerminals = new Map<string, vscode.Terminal>();
  private _disposed = false;

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

  /** Find a Claude Code binary.
   *  1. codekey CLI
   *  2. CC extension bundled binary
   *  3. Global claude on PATH
   */
  private _findClaudeBinary(): { path: string; args: string[] } | null {
    const cliPath = findCli();
    if (cliPath) return { path: cliPath, args: ['claude'] };

    const ccExt = vscode.extensions.getExtension('anthropic.claude-code');
    if (ccExt) {
      const binaryName = process.platform === 'win32' ? 'claude.exe' : 'claude';
      const binaryPath = path.join(ccExt.extensionUri.fsPath, 'resources', 'native-binary', binaryName);
      try {
        if (fs.existsSync(binaryPath)) return { path: binaryPath, args: [] };
      } catch { /* ignore */ }
    }

    // Fallback: global claude binary on PATH
    try {
      const which = execSync(process.platform === 'win32' ? 'where claude.exe' : 'which claude', { encoding: 'utf-8', timeout: 3000 }).trim().split('\n')[0];
      if (which && fs.existsSync(which)) return { path: which, args: [] };
    } catch { /* not in PATH */ }

    return null;
  }

  private async _poll(): Promise<void> {
    if (this._disposed) return;

    try {
      const resp = await fetch(`${BRIDGE_URL}/v1/pending-commands`);
      if (!resp.ok) return;
      const commands = await resp.json() as { id: string; sessionId?: string; claudeSessionId?: string; cwd?: string; text: string }[];
      if (commands.length === 0) return;

      const term = this._findManagedTerminal();
      const claudeBinary = term ? null : this._findClaudeBinary();
      console.error('[command-relay] _poll: commands=%d term=%s claudeBinary=%s', commands.length, !!term, !!claudeBinary);
      console.error('[command-relay] terminals:', vscode.window.terminals.map(t => ({ name: t.name, exitStatus: t.exitStatus })));
      const deliverable = commands.filter(c => term || (claudeBinary && c.claudeSessionId));
      if (deliverable.length === 0) {
        console.error('[command-relay] no deliverable target, command_ids=%s', commands.map(c => c.id).join(','));
        return;
      }

      const ids = deliverable.map(c => c.id);
      const claimResp = await fetch(`${BRIDGE_URL}/v1/pending-commands/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!claimResp.ok) return;
      const claimed = await claimResp.json() as { id: string; claudeSessionId?: string; cwd?: string; text: string }[];

      for (const cmd of claimed) {
        if (term) {
          // Terminal mode: sendText to managed terminal
          term.sendText(cmd.text, true);
        } else if (claudeBinary && cmd.claudeSessionId) {
          // Tab/panel mode: use a hidden VS Code Terminal + sendText to provide a real TTY.
          // CC detects TTY and runs in interactive mode → PermissionRequest hook fires for tool
          // approvals. Pipe stdin (spawn) would make CC skip approval hooks entirely.
          this._sendToResumeTerminal(cmd.claudeSessionId, cmd.text, cmd.cwd, claudeBinary);
        }
      }
    } catch {
      // bridge not reachable — skip this cycle
    }
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
    sessionId: string,
    text: string,
    cwd: string | undefined,
    binary: { path: string; args: string[] },
  ): void {
    // Reuse existing terminal for this session
    let term = this._resumeTerminals.get(sessionId);
    if (term && !vscode.window.terminals.includes(term)) {
      console.error('[command-relay] resume terminal for session=%s was closed externally, cleaning up', sessionId.slice(0, 8));
      this._resumeTerminals.delete(sessionId);
      term = undefined;
    }

    const isNewTerminal = !term;
    if (!term) {
      console.error('[command-relay] creating resume terminal for session=%s binary=%s cwd=%s',
        sessionId.slice(0, 8), binary.path, cwd ?? '(default)');
      term = vscode.window.createTerminal({
        name: `CodeKey: ${sessionId.slice(0, 8)}`,
        cwd: cwd ?? vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath,
        shellPath: binary.path,
        shellArgs: [...binary.args, '--resume', sessionId],
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
      // before writing the first command. Newer / larger transcripts take longer.
      console.error('[command-relay] new terminal, delaying sendText by 3s for session=%s', sessionId.slice(0, 8));
      setTimeout(() => {
        console.error('[command-relay] sendText to resume terminal session=%s text=%s', sessionId.slice(0, 8), text);
        term!.sendText(text, true);
      }, 3000);
    } else {
      console.error('[command-relay] sendText to resume terminal session=%s text=%s', sessionId.slice(0, 8), text);
      term!.sendText(text, true);
    }
  }

  dispose(): void {
    this.stop();
  }
}
