import * as vscode from 'vscode';
import { loadCredentials } from './auth/credentials.js';
import { StatusBar } from './status/bar.js';
import { showDashboard } from './commands/show-dashboard.js';
import { pairDevice } from './commands/pair.js';
import { findExistingClaudeTerminal, classifyTerminal, startClaudeCode, ensureCcSessionSync } from './commands/start-claude.js';
import { enableHook } from './commands/enable-hook.js';
import { SidebarProvider } from './webview/sidebar-provider.js';
import { CommandRelayService } from './services/command-relay.js';
import { BridgeStatusService } from './services/bridge-status.js';
import { log } from './log.js';

let statusBar: StatusBar | null = null;

export function activate(context: vscode.ExtensionContext) {
  log('=== CodeKey activating ===');
  log('windowId via vscode.env.sessionId:', vscode.env.sessionId);
  BridgeStatusService.setExtensionPath(context.extensionUri.fsPath);
  // Don't force-show — let the user open it if they want

  // Expose window ID to hook scripts via environment so they can tag hook events
  // with the originating VS Code window. vscode.env.sessionId is unique per window.
  process.env.CODEKEY_WINDOW_ID = vscode.env.sessionId;

  statusBar = new StatusBar('codekey.showDashboard');

  const creds = loadCredentials();
  log(`creds: ${creds ? 'yes' : 'no'}`);

  // Allow self-signed certificates for relay HTTPS
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

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

  // Auto-bind: if VS Code already has a Claude Code terminal, attach to it
  const existingTerm = findExistingClaudeTerminal();
  if (existingTerm) {
    log(`auto-bound to existing terminal: "${existingTerm.name}"`);
    commandRelay.setTerminal(existingTerm);
  }

  // Bridge + hook + label sync (session created on Attach, not auto)
  ensureCcSessionSync(context);

  // Dynamic binding: detect new Claude Code terminals opened after activation
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((term) => {
      const r = classifyTerminal(term);
      if (!r.matched) return;

      if (r.matched !== 'fuzzy') {
        // Strict match — auto-bind
        log(`auto-bound to new terminal: "${term.name}"`);
        commandRelay.setTerminal(term);
      } else {
        // Fuzzy match — ask user before binding
        vscode.window.showInformationMessage(
          `Detected a terminal named "${term.name}" — connect CodeKey to it?`,
          'Bind',
        ).then((choice) => {
          if (choice === 'Bind') {
            log(`user-confirmed bind to fuzzy terminal: "${term.name}"`);
            commandRelay.setTerminal(term);
          }
        });
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codekey.showDashboard', () => {
      log('cmd: dashboard');
      showDashboard(context, statusBar!);
    }),
    vscode.commands.registerCommand('codekey.pairDevice', async () => {
      log('cmd: pair');
      try {
        await pairDevice(context, statusBar!);
      } catch (err) {
        vscode.window.showErrorMessage(`pair error: ${err}`);
      }
    }),
    vscode.commands.registerCommand('codekey.startClaudeCode', async () => {
      log('cmd: start');
      const term = await startClaudeCode(context, statusBar!);
      if (term) commandRelay.setTerminal(term);
    }),
    vscode.commands.registerCommand('codekey.enableHook', () => {
      log('cmd: enableHook');
      enableHook(context, statusBar!);
    }),
    vscode.commands.registerCommand('codekey.focusSidebar', () => {
      vscode.commands.executeCommand('workbench.view.extension.codekey');
    }),
  );

  log('=== CodeKey activated ===');
}

export function deactivate() {
  // Fire-and-forget: tell bridge to deactivate all sessions for this window.
  // Uses deactivate_by_window which matches both window-level and tab-level sessions.
  const windowId = vscode.env.sessionId;
  fetch('http://127.0.0.1:3001/v1/close-window', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ windowId }),
  }).catch(() => { /* bridge may already be gone */ });

  statusBar?.dispose();
  statusBar = null;
  BridgeStatusService.getInstance().dispose();
}
