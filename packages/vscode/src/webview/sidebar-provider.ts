import * as vscode from 'vscode';
import { loadCredentials } from '../auth/credentials.js';
import { createApi, ApiError, type SessionResponse } from '../api/client.js';
import { getAgents } from '../agents/registry.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import { SessionStore } from '../services/session-store.js';
import { renderSidebar, type SidebarState } from './sidebar-html.js';
import { log } from '../log.js';

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

    this._bridgeService.ensureStarted();
    this._pushState();
    this._startPolling();
  }

  private async fetchRecentClaudeSessions(): Promise<SidebarState['claudeSessions']> {
    try {
      const res = await fetch('http://127.0.0.1:3001/v1/claude-sessions/recent?limit=5');
      if (!res.ok) return [];
      const body = await res.json() as { ok: boolean; sessions?: any[] };
      return (body.ok ? body.sessions ?? [] : []).map((s: any) => ({
        sessionId: s.sessionId,
        title: s.title || '',
        cwd: s.cwd || '',
        updatedAt: s.updatedAt || '',
      }));
    } catch {
      return [];
    }
  }

  private async attachClaudeSession(sessionId: string): Promise<void> {
    try {
      const res = await fetch('http://127.0.0.1:3001/v1/claude-sessions/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        const creds = loadCredentials();
        if (creds?.deviceId) {
          await SessionStore.add(this._context, creds.deviceId, sessionId);
        }
        vscode.window.showInformationMessage(`Session ${sessionId.slice(0, 8)} attached`);
        // Open the CC extension's editor tab so the user can interact with the session
        this._resumeClaudeSession();
      } else {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        vscode.window.showErrorMessage(`Attach failed: ${(body as Record<string, unknown>).error || res.statusText}`);
      }
    } catch {
      vscode.window.showErrorMessage('Attach failed: bridge not available');
    }
  }

  /** Open the CC extension's editor tab so the user can interact with the attached session.
   *  If a CC editor tab already exists, just focus the panel — don't create a new tab. */
  private _resumeClaudeSession(): void {
    // Check if any CC editor tab is already open
    let hasTab = false;
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        if (tab.input instanceof vscode.TabInputWebview) {
          const viewType = (tab.input as any).viewType as string | undefined;
          if (viewType && viewType.endsWith('claudeVSCodePanel')) {
            hasTab = true;
            break;
          }
        }
      }
      if (hasTab) break;
    }
    if (hasTab) {
      // Tab exists — just focus the CC panel (activity bar), no new editor tab
      vscode.commands.executeCommand('claude-vscode.focus');
    } else {
      // No tab open — open the last used CC editor
      vscode.commands.executeCommand('claude-vscode.editor.openLast');
    }
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
        const windowId = vscode.env.sessionId;
        sessions = await api.getSessions(windowId);
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

    // Extract pending approvals (per-session for grouped display)
    for (const [sid, evts] of Object.entries(events)) {
      const session = sessions.find(s => s.id === sid);
      for (const e of evts) {
        if (e.pending && e.type === 'approval_required') {
          pendingApprovals.push({
            id: e.id,
            command: e.data?.command ?? e.data?.summary ?? '(unknown)',
            agent: session?.agent_type ?? 'unknown',
            risk: e.risk_level ?? 'medium',
            serverSessionId: sid,
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

    // Check bridge capabilities + attached sessions
    let canDetach = false;
    let attachedSessions: string[] = [];
    try {
      const healthResp = await fetch('http://127.0.0.1:3001/v1/health');
      if (healthResp.ok) {
        const health = await healthResp.json() as { supports?: string[] };
        canDetach = health.supports?.includes('detach-session') ?? false;
      }
    } catch {}

    if (canDetach) {
      try {
        const attResp = await fetch('http://127.0.0.1:3001/v1/attached-sessions');
        if (attResp.ok) {
          const attBody = await attResp.json() as { attached?: string[] };
          attachedSessions = attBody.attached ?? [];
        }
      } catch {}
    }

    // Build lookup: claudeSessionId → relay session title (synced tab label)
    const relayTitleByClaudeSessionId = new Map<string, string>();
    for (const s of sessions) {
      const csid = s.metadata?.claudeSessionId;
      const title = s.metadata?.title;
      if (csid && title) {
        relayTitleByClaudeSessionId.set(csid, title);
      }
    }

    // Fetch local transcript sessions and overlay relay titles where available
    const recentSessions = await this.fetchRecentClaudeSessions();
    const mergedClaudeSessions = recentSessions.map(s => ({
      ...s,
      title: relayTitleByClaudeSessionId.get(s.sessionId) || s.title,
      attached: attachedSessions.includes(s.sessionId),
      canDetach,
    }));

    const state: SidebarState = {
      deviceStatus,
      phoneName: 'WeChat Mini Program',
      bridge,
      agents,
      pendingApprovals,
      sessions,
      events,
      claudeSessions: mergedClaudeSessions,
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
      case 'refreshClaudeSessions':
        this._pushState();
        break;
      case 'attachClaudeSession':
        this.attachClaudeSession(msg.sessionId).then(() => this._pushState());
        break;
      case 'toggleAttachClaudeSession':
        if (msg.attached) {
          fetch('http://127.0.0.1:3001/v1/detach-session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claudeSessionId: msg.sessionId }),
          }).then(async (res) => {
            if (res.ok) {
              const creds = loadCredentials();
              if (creds?.deviceId) {
                await SessionStore.remove(this._context, creds.deviceId, msg.sessionId);
              }
            } else {
              vscode.window.showErrorMessage(`Detach failed: ${res.statusText}`);
            }
            this._pushState();
          });
        } else {
          this.attachClaudeSession(msg.sessionId).then(() => this._pushState());
        }
        break;
    }
  }

  dispose(): void {
    this._stopPolling();
    this._bridgeDisposable?.dispose();
  }
}
