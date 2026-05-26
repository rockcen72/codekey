import * as vscode from 'vscode';

const POLL_MS = 2000;
const BRIDGE_URL = 'http://127.0.0.1:3001';
const TERMINAL_NAME = 'CodeKey: Claude Code';

/**
 * Polls the bridge for pending commands from the phone.
 * Sends them ONLY to a CodeKey-managed Claude Code terminal.
 * If no managed terminal exists, commands stay in the queue.
 */
export class CommandRelayService {
  private _timer?: ReturnType<typeof setInterval>;
  /** The terminal CodeKey created — the ONLY terminal we write to */
  private _terminal?: vscode.Terminal;
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
  }

  /**
   * Called when the user launches Claude Code from the sidebar.
   * Stores the terminal ref so command-relay can write to it.
   */
  setTerminal(term: vscode.Terminal): void {
    this._terminal = term;
  }

  private async _poll(): Promise<void> {
    if (this._disposed) return;

    try {
      const resp = await fetch(`${BRIDGE_URL}/v1/pending-commands`);
      if (!resp.ok) return;
      const commands = await resp.json() as { id: string; text: string }[];
      if (commands.length === 0) return;

      // Only send if we have a live CodeKey-managed terminal
      const term = this._findManagedTerminal();
      if (!term) return; // commands stay in queue

      // Claim only the commands we're about to send (atomic by ID)
      const ids = commands.map(c => c.id);
      const claimResp = await fetch(`${BRIDGE_URL}/v1/pending-commands/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids }),
      });
      if (!claimResp.ok) return;
      const claimed = await claimResp.json() as { id: string; text: string }[];

      for (const cmd of claimed) {
        term.sendText(cmd.text, true);
      }
    } catch {
      // bridge not reachable — skip this cycle
    }
  }

  /** Find the CodeKey-managed terminal by name. Returns undefined if closed. */
  private _findManagedTerminal(): vscode.Terminal | undefined {
    if (this._terminal && vscode.window.terminals.includes(this._terminal)) {
      return this._terminal;
    }
    for (const t of vscode.window.terminals) {
      if (t.name === TERMINAL_NAME) {
        this._terminal = t;
        return t;
      }
    }
    this._terminal = undefined;
    return undefined;
  }

  dispose(): void {
    this.stop();
  }
}
