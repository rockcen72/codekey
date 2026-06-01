import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { CodexAppServerClient, type ServerRequestMessage } from '@codekey/shared/bridge';
import { resolveCodexBinaryForVSCode } from '../services/codex-binary-resolver.js';
import { log, debug } from '../log.js';

function detectPlatform(): 'win32' | 'linux' | 'darwin' {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

// ── Active session registry ────────────────────────────
// Allows the bridge/relay layer to find and respond to pending Codex approvals.
// In MVP this is an in-memory map; future: relay + mini program integration.

interface PendingApprovalEntry {
  requestId: string | number;
  client: CodexAppServerClient;
  method: string;
  command?: string;
  cwd?: string;
  createdAt: number;
  resolved: boolean;
}

const pendingApprovals = new Map<string | number, PendingApprovalEntry>();

export function getPendingCodexApprovals(): PendingApprovalEntry[] {
  return Array.from(pendingApprovals.values()).filter(a => !a.resolved);
}

export function respondToCodexApproval(requestId: string | number, decision: 'approve' | 'deny' | 'pause'): boolean {
  const entry = pendingApprovals.get(requestId);
  if (!entry || entry.resolved) return false;
  entry.client.respondApproval(requestId, decision);
  entry.resolved = true;
  pendingApprovals.delete(requestId);
  return true;
}

// ── Session starter ────────────────────────────────────

/**
 * Start a Codex managed app-server session.
 * Approvals are presented as VS Code notifications (not auto-approved).
 * Full relay/mini program integration TBD.
 */
export async function startCodexSession(context: vscode.ExtensionContext): Promise<void> {
  const binaryPath = resolveCodexBinaryForVSCode(context.extensionUri.fsPath);
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
    onApproval: (req: ServerRequestMessage) => {
      // Store pending approval — do NOT auto-approve
      const id = req.id;
      pendingApprovals.set(id, {
        requestId: id,
        client,
        method: req.method,
        command: JSON.stringify(req.params?.command ?? req.params?.parsedCmd ?? ''),
        cwd: req.params?.cwd as string | undefined,
        createdAt: Date.now(),
        resolved: false,
      });
      log('[Codex] pending approval:', id, req.method);

      // Show VS Code notification (MVP — future: relay → mini program)
      const cmd = (req.params?.command as string[])?.join(' ') || req.method;
      const action = `Approve: ${cmd.slice(0, 80)}`;
      vscode.window.showInformationMessage(
        `Codex requires approval: ${cmd.slice(0, 120)}`,
        'Approve', 'Deny',
      ).then(selected => {
        if (selected === 'Approve') {
          respondToCodexApproval(id, 'approve');
          vscode.window.showInformationMessage('Codex command approved');
        } else if (selected === 'Deny') {
          respondToCodexApproval(id, 'deny');
        }
      });
    },
    onInput: (req: ServerRequestMessage) => {
      log('[Codex] input request:', req.method, req.id);
      // MVP: input requests are logged but not answered (user would need to type)
      // Show a VS Code notification that input is needed
      vscode.window.showWarningMessage(`Codex needs user input — check terminal`);
    },
    onExpired: (reqId, reason) => {
      log('[Codex] request expired:', reqId, reason);
      pendingApprovals.delete(reqId);
    },
  });

  try {
    await client.start();
    log('[Codex] app-server initialized');

    const threadId = await client.startThread('workspace-write');
    log('[Codex] thread started:', threadId);

    // Send an initial prompt to start a conversation
    const prompt = vscode.workspace.getConfiguration('codekey').get<string>('codexInitialPrompt')
      || 'Analyze the current project structure and provide a summary of what this project does.';
    await client.startTurn(prompt);
    log('[Codex] turn started');

    const terminal = vscode.window.createTerminal({
      name: `Codex: ${threadId.slice(0, 8)}`,
      cwd,
      hideFromUser: false,
    });
    terminal.sendText(`// Codex session ${threadId} — managed by CodeKey`);
    terminal.show();

    // Cleanup on dispose
    context.subscriptions.push({ dispose: () => { client.stop(); } });

    vscode.window.showInformationMessage(`Codex session started: ${threadId.slice(0, 8)}`);
  } catch (err) {
    log('[Codex] start error:', err);
    vscode.window.showErrorMessage(`Codex start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
