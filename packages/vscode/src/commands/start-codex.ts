import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { CodexAppServerClient } from '@codekey/shared/bridge';
import { resolveCodexBinaryForVSCode } from '../services/codex-binary-resolver.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import { log, debug } from '../log.js';

const bridgeService = BridgeStatusService.getInstance();

function detectPlatform(): 'win32' | 'linux' | 'darwin' {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

/**
 * Start a Codex managed app-server session.
 */
export async function startCodexSession(context: vscode.ExtensionContext): Promise<void> {
  const binaryPath = resolveCodexBinaryForVSCode(bridgeService.getExtensionPath());
  if (!binaryPath) {
    vscode.window.showErrorMessage(
      'Codex binary not found. Configure codekey.codexExecutable in settings or install Codex CLI.',
    );
    return;
  }

  log('[Codex] starting session with binary:', binaryPath);

  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath;
  if (!cwd) {
    vscode.window.showErrorMessage('Open a workspace folder before starting a Codex session.');
    return;
  }

  const client = new CodexAppServerClient({
    binarySearch: {
      configuredPath: binaryPath,
      pathEntries: [],
      platform: detectPlatform(),
      bundledPath: binaryPath,
      fs: { existsSync },
    },
    cwd,
    onApproval: (req) => {
      debug('[Codex] approval request:', req.method, req.id);
      // TODO: forward to relay → mini program
      client.respondApproval(req.id, 'approve');
    },
    onInput: (req) => {
      debug('[Codex] input request:', req.method, req.id);
      client.respondInput(req.id, {});
    },
    onExpired: (reqId, reason) => {
      log('[Codex] request expired:', reqId, reason);
    },
  });

  try {
    await client.start();
    log('[Codex] app-server initialized');

    const threadId = await client.startThread('workspace-write');
    log('[Codex] thread started:', threadId);

    const terminal = vscode.window.createTerminal({
      name: `Codex: ${threadId.slice(0, 8)}`,
      cwd,
      hideFromUser: false,
    });
    terminal.sendText(`// Codex session ${threadId} — managed by CodeKey`);
    terminal.show();

    context.subscriptions.push({ dispose: () => client.stop() });
    vscode.window.showInformationMessage(`Codex session started: ${threadId.slice(0, 8)}`);
  } catch (err) {
    log('[Codex] start error:', err);
    vscode.window.showErrorMessage(`Codex start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
