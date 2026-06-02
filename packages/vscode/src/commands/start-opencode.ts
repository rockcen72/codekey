import * as vscode from 'vscode';
import { randomInt } from 'node:crypto';

export function startOpenCodeTerminal(sessionId?: string): void {
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
  term.show();
  const cmd = sessionId
    ? `opencode --session ${sessionId} --port ${port}`
    : `opencode --port ${port}`;
  term.sendText(cmd);
}
