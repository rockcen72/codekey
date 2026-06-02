import * as vscode from 'vscode';
import { BridgeStatusService } from './bridge-status.js';
import { log } from '../log.js';

const POLL_MS = 1000;

interface BridgePendingApproval {
  id: string;
  serverEventId?: string;
  serverSessionId: string;
  agentType: string;
  command: string;
  summary: string;
  toolName: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
}

export class ApprovalNotificationService implements vscode.Disposable {
  private _timer?: ReturnType<typeof setInterval>;
  private _disposed = false;
  private _visible = new Set<string>();
  private _handled = new Set<string>();
  private _bridgeService = BridgeStatusService.getInstance();

  start(): void {
    this._poll().catch(() => {});
    this._timer = setInterval(() => this._poll().catch(() => {}), POLL_MS);
  }

  dispose(): void {
    this._disposed = true;
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = undefined;
    }
  }

  private async _poll(): Promise<void> {
    if (this._disposed) return;
    const resp = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/pending-approvals`).catch(() => null);
    if (!resp?.ok) return;

    const body = await resp.json() as { approvals?: BridgePendingApproval[] };
    const approvals = body.approvals ?? [];
    const liveIds = new Set(approvals.map((a) => a.id));
    for (const id of [...this._visible]) {
      if (!liveIds.has(id)) this._visible.delete(id);
    }

    for (const approval of approvals) {
      if (approval.agentType !== 'codex') continue;
      if (!approval.serverEventId) continue;
      if (this._visible.has(approval.id) || this._handled.has(approval.id)) continue;
      this._visible.add(approval.id);
      this._showApproval(approval).catch((err) => log(`approval notification failed: ${err?.stack || err}`));
    }
  }

  private async _showApproval(approval: BridgePendingApproval): Promise<void> {
    const title = approval.toolName ? `${approval.toolName}: ${approval.summary}` : approval.summary;
    const command = approval.command && approval.command !== approval.summary ? `\n${approval.command.slice(0, 220)}` : '';
    const choice = await vscode.window.showWarningMessage(
      `CodeKey approval required (${approval.risk})\n${title}${command}`,
      { modal: false },
      'Approve',
      'Deny',
      'Open CodeKey',
    );

    if (this._disposed) return;
    if (choice === 'Open CodeKey') {
      vscode.commands.executeCommand('workbench.view.extension.codekey');
      return;
    }
    if (choice !== 'Approve' && choice !== 'Deny') {
      this._visible.delete(approval.id);
      return;
    }

    this._handled.add(approval.id);
    const decision = choice === 'Approve' ? 'approve' : 'deny';
    const resp = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/approval-response`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId: approval.serverSessionId,
        eventId: approval.serverEventId,
        clientEventId: approval.id,
        decision,
        message: '',
      }),
    }).catch(() => null);

    if (!resp?.ok) {
      this._handled.delete(approval.id);
      this._visible.delete(approval.id);
      vscode.window.showErrorMessage(`CodeKey approval failed: ${resp?.statusText || 'bridge not available'}`);
    }
  }
}
