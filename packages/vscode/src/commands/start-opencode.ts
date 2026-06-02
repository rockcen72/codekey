import * as vscode from 'vscode';
import { randomInt } from 'node:crypto';

const openedSessions = new Set<string>();

export function hasOpenCodeTerminal(sessionId: string): boolean {
  return openedSessions.has(sessionId);
}

export function startOpenCodeTerminal(sessionId?: string): vscode.Terminal | null {
  if (sessionId && openedSessions.has(sessionId)) {
    // Find and focus existing terminal
    const name = `opencode-${sessionId.slice(0, 8)}`;
    const existing = vscode.window.terminals.find(t => t.name === name);
    if (existing) { existing.show(); return existing; }
    // Terminal was closed externally — remove from set
    openedSessions.delete(sessionId);
  }

  const port = randomInt(16384, 65536);
  const name = sessionId ? `opencode-${sessionId.slice(0, 8)}` : 'opencode';
  const term = vscode.window.createTerminal({
    name,
    location: {
      viewColumn: vscode.ViewColumn.Beside,
      preserveFocus: false,
    },
    env: {
      _EXTENSION_OPENCODE_PORT: String(port),
      OPENCODE_CALLER: 'vscode',
    },
  });

  if (sessionId) openedSessions.add(sessionId);

  // Clean up tracking when terminal is closed
  vscode.window.onDidCloseTerminal((t) => {
    if (t === term && sessionId) openedSessions.delete(sessionId);
  });

  term.show();
  const cmd = sessionId
    ? `opencode --session ${sessionId} --port ${port}`
    : `opencode --port ${port}`;
  term.sendText(cmd);
  return term;
}
