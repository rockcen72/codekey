import * as vscode from 'vscode';
import { randomInt } from 'node:crypto';

export function startOpenCodeTerminal(sessionId?: string): vscode.Terminal | null {
  const name = sessionId ? `opencode-${sessionId.slice(0, 8)}` : 'opencode';
  // Check VS Code terminals first (survives extension reloads)
  const existing = vscode.window.terminals.find(t => t.name === name);
  if (existing) { existing.show(); return existing; }

  const port = randomInt(16384, 65536);
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

  term.show();
  const cmd = sessionId
    ? `opencode --session ${sessionId} --port ${port}`
    : `opencode --port ${port}`;
  term.sendText(cmd);
  return term;
}
