import * as vscode from 'vscode';
import { loadCredentials } from './auth/credentials.js';
import { StatusBar } from './status/bar.js';
import { showDashboard } from './commands/show-dashboard.js';
import { pairDevice } from './commands/pair.js';
import { startCodexSession } from './commands/start-codex.js';
import { findExistingClaudeTerminal, classifyTerminal, startClaudeCode, ensureCcSessionSync } from './commands/start-claude.js';
import { enableHook } from './commands/enable-hook.js';
import { installCodexHook, isCodexHookInstalled, isCodexExtensionActive, uninstallCodexHook } from './hook/codex-installer.js';
import { installOpenCodePlugin, isOpenCodePluginInstalled, isOpenCodeCliInstalled, uninstallOpenCodePlugin } from './hook/opencode-installer.js';
import { startOpenCodeTerminal } from './commands/start-opencode.js';
import { SidebarProvider } from './webview/sidebar-provider.js';
import { CommandRelayService } from './services/command-relay.js';
import { BridgeStatusService } from './services/bridge-status.js';
import { CodexApprovalNoticeService } from './services/codex-approval-notice.js';
import { log, setVerbose, isVerbose } from './log.js';
import { secureFetch } from './util/secure-fetch.js';

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

  // TLS verification is enabled by default. The production domain
  // (codekey.tinymoney.cn) is served with a valid Let's Encrypt certificate.
  // For local development or temporary deployment on IP-based endpoints
  // where the cert SAN does not include the IP, set:
  //   CODEKEY_INSECURE_TLS_HOSTS=81.70.235.58
  // Comma-separated hostnames. The relay CLIENT (PC extension + bridge WS)
  // skips certificate verification ONLY for these hosts. Everything else
  // still enforces strict TLS. This is a temporary workaround — drop the
  // env var once the target hostname matches its certificate.
  //
  // Alternative escape hatch: CODEKEY_INSECURE_TLS=1 disables verification
  // globally. NEVER use in production.
  const insecureHosts = (process.env.CODEKEY_INSECURE_TLS_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  if (insecureHosts.length > 0) {
    console.warn(
      `[CodeKey] CODEKEY_INSECURE_TLS_HOSTS=${insecureHosts.join(',')} — TLS verification disabled for these hosts only. Remove once the relay is served from a hostname matching its certificate.`,
    );
    // The shared bridge WebSocket client reads this list to decide per-host
    // whether to set { rejectUnauthorized: false } on its `ws` connection.
    process.env.CODEKEY_INSECURE_TLS_HOSTS = insecureHosts.join(',');
  }
  if (process.env.CODEKEY_INSECURE_TLS === '1') {
    console.warn('[CodeKey] CODEKEY_INSECURE_TLS=1 — TLS verification disabled GLOBALLY. NEVER use in production.');
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  }

  if (creds?.deviceToken) {
    secureFetch(`${creds.relayUrl}/health`)
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

  const codexApprovalNotice = new CodexApprovalNoticeService();
  codexApprovalNotice.start();
  context.subscriptions.push(codexApprovalNotice);

  // Auto-bind: if VS Code already has a Claude Code terminal, attach to it
  const existingTerm = findExistingClaudeTerminal();
  if (existingTerm) {
    log(`auto-bound to existing terminal: "${existingTerm.name}"`);
    commandRelay.setTerminal(existingTerm);
  }

  // Bridge + hook + label sync (session created on Attach, not auto)
  ensureCcSessionSync(context);

  // Auto-install/refresh Codex hooks only after pairing. These hooks are global
  // to Codex, so an unpaired CodeKey install must not affect normal Codex usage.
  if (creds?.deviceToken && isCodexExtensionActive()) {
    const scriptsDir = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
    installCodexHook(scriptsDir);
    log('Codex hooks auto-installed/refreshed');
  } else if (!creds?.deviceToken && isCodexHookInstalled()) {
    uninstallCodexHook();
    log('Codex hooks removed because CodeKey is not paired');
  }

  // OpenCode telemetry plugin is installed via explicit command (CodeKey: Enable OpenCode Integration)
  // — do NOT auto-install on activation (see approved plan).

  // Dynamic binding: detect new Claude Code terminals opened after activation
  context.subscriptions.push(
    vscode.window.onDidOpenTerminal((term) => {
      // Skip our own resume terminals created by CommandRelayService
      if (term.name.startsWith('CodeKey: Claude ') && term.name !== 'CodeKey: Claude Code') return;

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
    vscode.commands.registerCommand('codekey.startCodexSession', () => {
      log('cmd: startCodex');
      startCodexSession(context);
    }),
    vscode.commands.registerCommand('codekey.enableHook', () => {
      log('cmd: enableHook');
      enableHook(context, statusBar!);
    }),
    vscode.commands.registerCommand('codekey.focusSidebar', () => {
      vscode.commands.executeCommand('workbench.view.extension.codekey');
    }),
    vscode.commands.registerCommand('codekey.restartBridge', async () => {
      log('cmd: restartBridge');
      await BridgeStatusService.getInstance().restart();
      vscode.window.showInformationMessage('CodeKey bridge restarted');
    }),
    vscode.commands.registerCommand('codekey.toggleDebugLog', () => {
      setVerbose(!isVerbose());
      vscode.window.showInformationMessage(`CodeKey debug logging: ${isVerbose() ? 'ON' : 'OFF'}`);
    }),
    vscode.commands.registerCommand('codekey.enableOpenCode', () => {
      log('cmd: enableOpenCode');
      if (!isOpenCodeCliInstalled()) {
        vscode.window.showErrorMessage('OpenCode CLI not found. Install opencode first: npm install -g opencode');
        return;
      }
      if (isOpenCodePluginInstalled()) {
        vscode.window.showInformationMessage('OpenCode integration already enabled');
        return;
      }
      try {
        const scriptsDir = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
        installOpenCodePlugin(scriptsDir);
        vscode.window.showInformationMessage('OpenCode integration enabled — restart OpenCode to load the telemetry plugin');
        log('OpenCode telemetry plugin installed');
      } catch (err) {
        vscode.window.showErrorMessage(`Failed to enable OpenCode integration: ${err}`);
      }
    }),
    vscode.commands.registerCommand('codekey.startOpenCode', (sessionId?: string) => {
      log('cmd: startOpenCode' + (sessionId ? ` session=${sessionId}` : ''));
      startOpenCodeTerminal(sessionId);
    }),
    vscode.commands.registerCommand('codekey.toggleCodexHook', () => {
      log('cmd: toggleCodexHook');
      if (isCodexHookInstalled()) {
        uninstallCodexHook();
        vscode.window.showInformationMessage('Codex hook removed');
      } else {
        const scriptsDir = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
        installCodexHook(scriptsDir);
        vscode.window.showInformationMessage('Codex hook installed');
      }
    }),
  );

  log('=== CodeKey activated ===');
}

export async function deactivate() {
  // Tell bridge to deactivate all sessions before we kill it.
  // Use AbortSignal with 2s timeout so VS Code doesn't hang on extension deactivation.
  const windowId = vscode.env.sessionId;
  try {
    await fetch(`${BridgeStatusService.getInstance().getBridgeUrl()}/v1/close-window`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId }),
      signal: AbortSignal.timeout(2000),
    });
  } catch { /* bridge may already be gone */ }

  statusBar?.dispose();
  statusBar = null;
  BridgeStatusService.getInstance().dispose();
}
