import * as vscode from 'vscode';
import { existsSync } from 'node:fs';
import { CodexAppServerClient, type ServerRequestMessage } from '@codekey/shared/bridge';
import { resolveCodexBinaryForVSCode } from '../services/codex-binary-resolver.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import { log, debug } from '../log.js';

function detectPlatform(): 'win32' | 'linux' | 'darwin' {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

function bridgeUrl(): string {
  return `http://127.0.0.1:${BridgeStatusService.getInstance().getBridgePort()}`;
}

/**
 * Start a Codex managed app-server session.
 * Approvals are posted to the bridge, which forwards them to the relay/mini program.
 * The extension polls the bridge for decisions and calls respondApproval().
 */
async function waitForBridgeHealth(url: string, maxRetries: number = 10, delayMs: number = 1000): Promise<void> {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const resp = await fetch(url + '/v1/health', { signal: AbortSignal.timeout(2000) });
      if (resp.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, delayMs));
  }
  throw new Error('Bridge did not become healthy');
}

export async function startCodexSession(context: vscode.ExtensionContext): Promise<void> {
  const binaryPath = resolveCodexBinaryForVSCode(context.extensionUri.fsPath);
  if (!binaryPath) {
    vscode.window.showErrorMessage(
      'Codex binary not found. Configure codekey.codexExecutable in settings or install Codex CLI.',
    );
    return;
  }

  log('[Codex] starting session with binary:', binaryPath);

  // Ensure bridge is running before starting Codex (approvals go through bridge HTTP)
  BridgeStatusService.getInstance().ensureStarted();
  await waitForBridgeHealth(bridgeUrl());
  log('[Codex] bridge is healthy');

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
      // Post to bridge → relay → mini program
      const correlationId = String(req.id);
      const command = JSON.stringify(req.params?.command ?? req.params?.parsedCmd ?? req.method);
      const risk = 'medium';

      // Register with bridge for mini program relay
      fetch(`${bridgeUrl()}/v1/codex/approval`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ correlationId, command, risk }),
      }).catch(err => debug('[Codex] failed to register approval with bridge:', err));
    },
    onInput: (req: ServerRequestMessage) => {
      debug('[Codex] input request (MVP: not wired to mini program, empty response sent):', req.id);
      vscode.window.showWarningMessage('Codex needs input — check the Codex terminal');
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

    // Register notification listeners BEFORE startTurn (so initial turn events are captured)
    let agentContent = '';
    client.on('raw_notification', (method: string, _msg: Record<string, unknown>) => {
      if (method === 'item/agentMessage/delta') {
        const params = _msg.params as Record<string, unknown> | undefined;
        if (params?.delta && typeof params.delta === 'string') agentContent += params.delta;
      }
    });
    client.on('notification', (method: string) => {
      if (method === 'turn/completed') {
        const summary = agentContent.slice(0, 500) || 'Codex turn completed';
        agentContent = '';
        fetch(`${bridgeUrl()}/v1/codex/event`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ eventType: 'task_complete', data: { summary } }),
        }).catch(() => {});
      }
    });

    // Register Codex session with relay so mini program can see and interact
    try {
      await fetch(`${bridgeUrl()}/v1/codex/session/ensure`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          windowId: vscode.env.sessionId,
          title: `Codex: ${threadId.slice(0, 8)}`,
          cwd,
        }),
        signal: AbortSignal.timeout ? AbortSignal.timeout(5000) : undefined,
      });
    } catch (err) {
      debug('[Codex] session ensure (non-fatal):', err);
    }

    // Send an initial prompt
    const prompt = vscode.workspace.getConfiguration('codekey').get<string>('codexInitialPrompt')
      || 'Analyze the current project structure and provide a summary.';
    await client.startTurn(prompt);
    log('[Codex] turn started');

    // Create terminal
    const terminal = vscode.window.createTerminal({
      name: `Codex: ${threadId.slice(0, 8)}`,
      cwd,
      hideFromUser: false,
    });
    terminal.sendText(`// Codex session ${threadId} — managed by CodeKey`);
    terminal.show();



    // Poll for mini program decisions (every 2s, same cadence as CommandRelayService)
    const pollTimer = setInterval(async () => {
      try {
        // Poll decisions (approval responses)
        const decResp = await fetch(`${bridgeUrl()}/v1/codex/decisions`);
        if (decResp.ok) {
          const { decisions } = await decResp.json() as { decisions: { correlationId: string; decision: string }[] };
          for (const d of decisions) {
            const codexDecision = d.decision === 'approve' ? 'approve' as const : d.decision === 'deny' ? 'deny' as const : 'pause' as const;
            client.respondApproval(d.correlationId, codexDecision);
            debug('[Codex] applied decision:', d.correlationId, d.decision);
          }
        }
      } catch { /* bridge not ready yet */ }
      try {
        // Poll prompts (remote input from mini program)
        const prResp = await fetch(`${bridgeUrl()}/v1/codex/prompts`);
        if (prResp.ok) {
          const { prompts } = await prResp.json() as { prompts: string[] };
          // Serial queue: process one prompt at a time, await each
          for (const prompt of prompts) {
            debug('[Codex] remote prompt:', prompt.slice(0, 80));
            try {
              await client.startTurn(prompt);
              debug('[Codex] prompt completed');
            } catch (err) {
              log('[Codex] prompt failed:', err);
            }
          }
        }
      } catch {}
    }, 2000);

    context.subscriptions.push({
      dispose: () => {
        clearInterval(pollTimer);
        client.stop();
      },
    });

    vscode.window.showInformationMessage(`Codex session started: ${threadId.slice(0, 8)}`);
  } catch (err) {
    log('[Codex] start error:', err);
    vscode.window.showErrorMessage(`Codex start failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}
