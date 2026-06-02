import * as vscode from 'vscode';
import { randomInt } from 'node:crypto';

export function startOpenCodeTerminal(): void {
  const port = randomInt(16384, 65536);
  const term = vscode.window.createTerminal({
    name: 'opencode',
    location: vscode.TerminalLocation.Panel,
    env: {
      _EXTENSION_OPENCODE_PORT: String(port),
      OPENCODE_CALLER: 'vscode',
    },
  });
  term.show();
  term.sendText(`opencode --port ${port}`);
}
