import * as vscode from 'vscode';
import { log } from '../log.js';
import { BridgeStatusService } from './bridge-status.js';

const POLL_MS = 1000;

interface BridgePendingApproval {
  id: string;
  agentType: string;
}

export class CodexApprovalNoticeService implements vscode.Disposable {
  private _timer?: ReturnType<typeof setInterval>;
  private _disposed = false;
  private _notifiedIds = new Set<string>();
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

    const body = await resp.json().catch(() => ({})) as { approvals?: BridgePendingApproval[] };
    const codexApprovals = (body.approvals ?? []).filter((approval) => approval.agentType === 'codex');
    const liveIds = new Set(codexApprovals.map((approval) => approval.id));
    for (const id of [...this._notifiedIds]) {
      if (!liveIds.has(id)) this._notifiedIds.delete(id);
    }

    const newIds = codexApprovals
      .map((approval) => approval.id)
      .filter((id) => !this._notifiedIds.has(id));
    if (newIds.length === 0) return;

    for (const id of newIds) this._notifiedIds.add(id);
    this._showNotice(codexApprovals.length).catch((err) => {
      log(`codex approval notice failed: ${err?.stack || err}`);
    });
  }

  private async _showNotice(count: number): Promise<void> {
    const zh = vscode.env.language.toLowerCase().startsWith('zh');
    const message = zh
      ? `Codex 当前有 ${count} 个请求需要在移动端审批。`
      : `Codex has ${count} request${count === 1 ? '' : 's'} waiting for approval on your mobile device.`;
    await vscode.window.showInformationMessage(message);
  }
}
