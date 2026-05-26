import * as vscode from 'vscode';
import { loadCredentials } from '../auth/credentials.js';
import { findCli } from '../cli.js';
import type { StatusBar } from '../status/bar.js';

export async function pairDevice(context: vscode.ExtensionContext, statusBar: StatusBar): Promise<void> {
  try {
    const existing = loadCredentials();
    const relayUrl = existing?.relayUrl ?? 'http://localhost:3000';
    const cliPath = findCli();

    if (!cliPath) {
      vscode.window.showErrorMessage(
        'CodeKey CLI not found. Install it with: npm install -g @codekey/cli',
      );
      return;
    }

    // PowerShell requires & prefix for quoted executables; cmd.exe / POSIX handle bare quotes
    const isWin = process.platform === 'win32';
    const cmd = isWin
      ? `& "${cliPath}" login --relay ${relayUrl}`
      : `"${cliPath}" login --relay ${relayUrl}`;

    const terminal = vscode.window.createTerminal({
      name: 'CodeKey Pair',
    });
    terminal.show();
    terminal.sendText(cmd, true);
  } catch (err) {
    vscode.window.showErrorMessage(`CodeKey Pair error: ${err}`);
  }
}
