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
import { SessionStore } from './services/session-store.js';
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

  // TLS verification is enabled by default. The relay server uses a valid
  // Let's Encrypt certificate. For local development or temporary deployment
  // on IP-based endpoints where the cert SAN does not include the IP
  // (common while a domain is still in ICP filing), set:
  //   CODEKEY_INSECURE_TLS_HOSTS=81.70.235.58,api.example.dev
  // Comma-separated hostnames. The relay CLIENT (PC extension + bridge WS)
  // skips certificate verification ONLY for these hosts. Everything else
  // still enforces strict TLS. This is a temporary workaround — once the
  // domain is in production, drop the env var and re-package.
  //
  // Alternative escape hatch: CODEKEY_INSECURE_TLS=1 disables verification
  // globally. NEVER use in production.
  const insecureHosts = (process.env.CODEKEY_INSECURE_TLS_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
  log(`CODEKEY_INSECURE_TLS_HOSTS=${JSON.stringify(process.env.CODEKEY_INSECURE_TLS_HOSTS ?? null)} → parsed=${JSON.stringify(insecureHosts)}`);
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

  // Auto-bind: if VS Code already has a Claude Code terminal, attach to it
  const existingTerm = findExistingClaudeTerminal();
  if (existingTerm) {
    log(`auto-bound to existing terminal: "${existingTerm.name}"`);
    commandRelay.setTerminal(existingTerm);
  }

  // Bridge + hook + label sync (session created on Attach, not auto)
  ensureCcSessionSync(context);

  // Auto-install Codex hooks (if Codex extension/detected and hooks not yet installed)
  if (isCodexExtensionActive() && !isCodexHookInstalled()) {
    const scriptsDir = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
    installCodexHook(scriptsDir);
    log('Codex hooks auto-installed');
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

  // Restore previously attached sessions (best-effort, after bridge is ready)
  restoreAttachedSessions(context).catch(err => log(`restoreAttachedSessions failed: ${err}`));

  log('=== CodeKey activated ===');
}

async function restoreAttachedSessions(context: vscode.ExtensionContext): Promise<void> {
  const creds = loadCredentials();
  if (!creds?.deviceId) return;
  const savedSessions = SessionStore.getByDevice(context, creds.deviceId);
  if (savedSessions.length === 0) return;
  log(`restoreAttachedSessions: ${savedSessions.length} sessions to restore for device ${creds.deviceId.slice(0, 8)}`);

  // Wait for bridge to be healthy (poll /v1/health, max 30s)
  for (let i = 0; i < 15; i++) {
    try {
      const resp = await fetch(`${BridgeStatusService.getInstance().getBridgeUrl()}/v1/health`);
      if (resp.ok) {
        // Bridge is ready — restore each session
        const sessionsToPrune: string[] = [];
        for (const saved of savedSessions) {
          try {
            const res = await fetch(`${BridgeStatusService.getInstance().getBridgeUrl()}/v1/claude-sessions/attach`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: saved.claudeSessionId }),
            });
            if (res.ok) {
              log(`restored session: ${saved.claudeSessionId.slice(0, 8)}`);
            } else if (res.status === 404) {
              // Transcript no longer exists — prune from store, don't retry
              log(`session ${saved.claudeSessionId.slice(0, 8)} not found (transcript deleted), pruning`);
              sessionsToPrune.push(saved.claudeSessionId);
            } else {
              log(`restore failed for ${saved.claudeSessionId.slice(0, 8)}: ${res.status}`);
            }
          } catch {
            // Network error — keep in store, retry next startup
            log(`restore error for ${saved.claudeSessionId.slice(0, 8)}: bridge unreachable`);
          }
        }
        // Prune sessions whose transcripts have been deleted
        if (sessionsToPrune.length > 0) {
          const all = SessionStore.getAll(context);
          const filtered = all.filter(s =>
            !(s.deviceId === creds.deviceId && sessionsToPrune.includes(s.claudeSessionId))
          );
          await SessionStore.setAll(context, filtered);
        }
        return;
      }
    } catch {
      // Bridge not ready yet — wait and retry
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  log('restoreAttachedSessions: bridge did not become healthy within 30s, giving up');
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
