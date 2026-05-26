import * as vscode from 'vscode';
import { loadCredentials } from './auth/credentials.js';
import { StatusBar } from './status/bar.js';
import { showDashboard } from './commands/show-dashboard.js';
import { pairDevice } from './commands/pair.js';
import { startClaudeCode } from './commands/start-claude.js';
import { enableHook } from './commands/enable-hook.js';
import { SidebarProvider } from './webview/sidebar-provider.js';
import { CommandRelayService } from './services/command-relay.js';

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

  // Sidebar provider
  const sidebarProvider = new SidebarProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(SidebarProvider.viewType, sidebarProvider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
  );

  // Command relay — polls bridge for phone→agent commands
  const commandRelay = new CommandRelayService();
  commandRelay.start();
  context.subscriptions.push(commandRelay);

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
      const term = startClaudeCode(context, statusBar!);
      if (term) commandRelay.setTerminal(term);
    }),
    vscode.commands.registerCommand('codekey.enableHook', () => {
      output.appendLine('cmd: enableHook');
      enableHook(context, statusBar!);
    }),
    vscode.commands.registerCommand('codekey.focusSidebar', () => {
      vscode.commands.executeCommand('workbench.view.extension.codekey');
    }),
  );

  output.appendLine('=== CodeKey activated ===');
}

export function deactivate() {
  statusBar?.dispose();
  statusBar = null;
}
