import * as vscode from 'vscode';
import { randomInt } from 'node:crypto';

let _creating: string | null = null;

export function startOpenCodeTerminal(sessionId?: string): vscode.Terminal | null {
  const name = sessionId ? `opencode-${sessionId.slice(0, 8)}` : 'opencode';
  const existing = vscode.window.terminals.find(t => t.name === name);
  if (existing) { existing.show(); return existing; }
  if (_creating === name) return null;

  _creating = name;
  const port = randomInt(16384, 65536);
  const term = vscode.window.createTerminal({
    name,
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    env: { _EXTENSION_OPENCODE_PORT: String(port), OPENCODE_CALLER: 'vscode' },
  });
  _creating = null;

  term.show();
  const cmd = sessionId
    ? `opencode --session ${sessionId} --port ${port}`
    : `opencode --port ${port}`;
  term.sendText(cmd);
  return term;
}
