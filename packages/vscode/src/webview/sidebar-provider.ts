import * as vscode from 'vscode';
import { loadCredentials } from '../auth/credentials.js';
import { createApi, ApiError, type SessionResponse } from '../api/client.js';
import { getAgents } from '../agents/registry.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import { renderSidebar, type SidebarState } from './sidebar-html.js';

const POLL_MS = 5000;

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codekey.sidebar';

  private _view?: vscode.WebviewView;
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _bridgeService = BridgeStatusService.getInstance();
  private _bridgeDisposable?: vscode.Disposable;

  constructor(private _context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this._view = webviewView;

    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.onDidReceiveMessage((msg) => this._onMessage(msg));

    this._bridgeDisposable = this._bridgeService.onDidChange(() => this._pushState());

    this._pushState();
    this._startPolling();
  }

  private async _pushState(): Promise<void> {
    if (!this._view) return;

    const creds = loadCredentials();
    const bridge = this._bridgeService.state;
    let deviceStatus: SidebarState['deviceStatus'] = 'unpaired';
    let sessions: SessionResponse[] = [];
    let events: Record<string, any[]> = {};
    let pendingApprovals: SidebarState['pendingApprovals'] = [];

    if (creds?.deviceToken) {
      try {
        const api = createApi(creds);
        sessions = await api.getSessions();
        await Promise.all(sessions.map(async (s) => {
          events[s.id] = await api.getSessionEvents(s.id).catch(() => []);
        }));
        deviceStatus = 'paired';
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
          deviceStatus = 'unpaired';
        } else {
          deviceStatus = 'offline';
        }
      }
    }

    // Extract pending approvals
    for (const [sid, evts] of Object.entries(events)) {
      const session = sessions.find(s => s.id === sid);
      for (const e of evts) {
        if (e.pending && e.type === 'approval_required') {
          pendingApprovals.push({
            id: e.id,
            command: e.data?.command ?? e.data?.summary ?? '(unknown)',
            agent: session?.agent_type ?? 'unknown',
            risk: e.risk_level ?? 'medium',
          });
        }
      }
    }

    // Determine runtime agent status
    const agents = getAgents().map(a => {
      if (a.status !== 'available') return { ...a, runtimeStatus: 'unavailable' as const };
      const agentSessions = sessions.filter(s => a.sessionAgentTypes.includes(s.agent_type));
      if (agentSessions.length === 0) return { ...a, runtimeStatus: 'idle' as const };

      let latestEvent: { type: string; data?: any; created_at: string } | null = null;
      let latestTs = 0;
      for (const s of agentSessions) {
        const evts = (events[s.id] || []).slice().sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        if (evts.length > 0) {
          const ts = new Date(evts[0].created_at).getTime();
          if (ts > latestTs) {
            latestTs = ts;
            latestEvent = evts[0];
          }
        }
      }

      let statusLine: string | undefined;
      let lastMessage: string | undefined;

      if (latestEvent) {
        switch (latestEvent.type) {
          case 'approval_required':
            statusLine = 'Awaiting approval';
            break;
          case 'task_complete':
            statusLine = 'Task complete';
            lastMessage = latestEvent.data?.summary;
            break;
          case 'session_idle':
            statusLine = 'Waiting for instruction';
            break;
          default:
            statusLine = 'Running...';
        }
      } else {
        statusLine = 'Running...';
      }

      return { ...a, runtimeStatus: 'active' as const, statusLine, lastMessage };
    });

    const state: SidebarState = {
      deviceStatus,
      phoneName: 'WeChat Mini Program',
      bridge,
      agents,
      pendingApprovals,
      sessions,
      events,
    };

    this._view.webview.html = renderSidebar(state);
  }

  private _startPolling(): void {
    this._stopPolling();
    this._pollTimer = setInterval(() => this._pushState(), POLL_MS);
  }

  private _stopPolling(): void {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  }

  private _onMessage(msg: any): void {
    switch (msg.action) {
      case 'pair':
        vscode.commands.executeCommand('codekey.pairDevice');
        break;
      case 'hook-settings':
        vscode.commands.executeCommand('codekey.enableHook');
        break;
      case 'start-agent':
        vscode.commands.executeCommand('codekey.startClaudeCode');
        break;
      case 'set-default':
        break;
    }
  }

  dispose(): void {
    this._stopPolling();
    this._bridgeDisposable?.dispose();
  }
}
