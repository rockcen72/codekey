import * as vscode from 'vscode';
import { loadCredentials } from '../auth/credentials.js';
import { findCli } from '../cli.js';
import type { StatusBar } from '../status/bar.js';

export function startClaudeCode(
  context: vscode.ExtensionContext,
  statusBar: StatusBar,
): vscode.Terminal | undefined {
  const creds = loadCredentials();
  if (!creds) {
    vscode.window.showWarningMessage(
      'CodeKey is not paired. Run CodeKey: Pair Device first.',
    );
    return;
  }

  if (!creds.deviceToken) {
    vscode.window.showWarningMessage(
      'No device token found. Run `codekey login` in the terminal to complete pairing.',
    );
    return;
  }

  const cliPath = findCli();
  if (!cliPath) {
    const install = 'Install';
    vscode.window.showWarningMessage(
      'CodeKey CLI not found. Install it from npm?',
      install,
    ).then((choice) => {
      if (choice === install) {
        const term = vscode.window.createTerminal({
          name: 'Install CodeKey CLI',
        });
        term.show();
        term.sendText('npm install -g @codekey/cli', true);
      }
    });
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: 'CodeKey: Claude Code',
    shellPath: cliPath,
    shellArgs: ['claude', '--relay', creds.relayUrl],
    iconPath: new vscode.ThemeIcon('sparkle'),
  });

  terminal.show();
  statusBar.set('paired');
  return terminal;
}
