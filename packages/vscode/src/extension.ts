import * as vscode from 'vscode';
import { loadCredentials } from './auth/credentials.js';
import { StatusBar } from './status/bar.js';
import { showDashboard } from './commands/show-dashboard.js';
import { pairDevice } from './commands/pair.js';
import { startClaudeCode } from './commands/start-claude.js';

let statusBar: StatusBar | null = null;

export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel('CodeKey');
  output.appendLine('=== CodeKey activating ===');
  output.show();

  statusBar = new StatusBar('codekey.showDashboard');

  const creds = loadCredentials();
  output.appendLine(`creds: ${creds ? 'yes' : 'no'}`);

  if (creds?.deviceToken) {
    fetch(`${creds.relayUrl}/health`)
      .then((res) => { if (statusBar && res.ok) statusBar.set('paired'); })
      .catch(() => { if (statusBar) statusBar.set('offline'); });
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('codekey.showDashboard', () => {
      output.appendLine('cmd: dashboard');
      showDashboard(context, statusBar!);
    }),
    vscode.commands.registerCommand('codekey.pairDevice', async () => {
      output.appendLine('cmd: pair');
      try {
        await pairDevice(context, statusBar!);
      } catch (err) {
        vscode.window.showErrorMessage(`pair error: ${err}`);
      }
    }),
    vscode.commands.registerCommand('codekey.startClaudeCode', () => {
      output.appendLine('cmd: start');
      startClaudeCode(context, statusBar!);
    }),
  );

  output.appendLine('=== CodeKey activated ===');
}

export function deactivate() {
  statusBar?.dispose();
  statusBar = null;
}
