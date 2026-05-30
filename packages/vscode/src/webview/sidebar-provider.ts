import * as vscode from 'vscode';
import * as path from 'node:path';
import { loadCredentials } from '../auth/credentials.js';
import { createApi, ApiError, type SessionResponse } from '../api/client.js';
import { getAgents } from '../agents/registry.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import { SessionStore } from '../services/session-store.js';

import { renderSidebar, type SidebarState } from './sidebar-html.js';
import { loadConversation } from '../../../shared/src/bridge/claude-transcripts.js';
import { log } from '../log.js';

const POLL_MS = 5000;

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codekey.sidebar';

  private _view?: vscode.WebviewView;
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _bridgeService = BridgeStatusService.getInstance();
  private _bridgeDisposable?: vscode.Disposable;
  private _hadCcRunning = false;

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

  /** Fetch active claudeSessionIds from bridge (sessions with CC tabs). */
  private async _fetchActiveSessionIds(): Promise<Set<string>> {
    try {
      const resp = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/active-sessions`);
      if (!resp.ok) return new Set();
      const body = await resp.json() as { active?: string[] };
      return new Set(body.active ?? []);
    } catch {
      return new Set();
    }
  }

  /** Check if Claude Code is currently running (terminal or official extension panel). */
  private _checkCcRunning(): boolean {
    // Mode 2/3: CC running in a VS Code terminal
    const hasTerminal = vscode.window.terminals.some(t => {
      const n = t.name;
      return n === 'CodeKey: Claude Code'
        || n === 'Claude Code'
        || /^Claude Code \(\d+\)$/.test(n)
        || /claude/i.test(n);
    });
    if (hasTerminal) return true;

    // Mode 1: official Claude Code extension panel (anthropic.claude-code)
    const ccExt = vscode.extensions.getExtension('anthropic.claude-code');
    if (ccExt?.isActive) return true;

    return false;
  }

  /** Auto-detach a session (called when user closes the CC terminal). */
  private async _autoDetachSession(claudeSessionId: string): Promise<void> {
    try {
      const res = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/detach-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeSessionId }),
      });
      if (res.ok) {
        const creds = loadCredentials();
        if (creds?.deviceId) {
          await SessionStore.remove(this._context, creds.deviceId, claudeSessionId);
        }
        log(`_autoDetachSession: detached ${claudeSessionId.slice(0, 8)} (CC terminal closed)`);
      }
    } catch {
      // bridge may already be gone
    }
  }

  /** Filter sessions: current workspace sessions.
   *  When CC is running, show all workspace transcript sessions (bypassing activeIds check).
   *  When CC is not running, only show stored (attached) sessions. */
  private _filterLocalSessions(
    sessions: SidebarState['claudeSessions'],
    activeIds: Set<string>,
    storedIds: Set<string>,
    hasCcRunning: boolean,
  ): SidebarState['claudeSessions'] {
    const workspacePaths = (vscode.workspace.workspaceFolders ?? []).map(f => f.uri.fsPath);
    if (workspacePaths.length === 0) return [];
    if (!hasCcRunning && activeIds.size === 0 && storedIds.size === 0) return [];

    const norm = (p: string) => path.resolve(p).toLowerCase();
    const normWorkspaces = workspacePaths.map(norm);

    // When CC is running, admit the 2 most-recent workspace sessions as fallback
    // (covers bridge restart window before hook events re-register the session).
    const recentFallbackIds = new Set<string>();
    if (hasCcRunning) {
      let admitted = 0;
      for (const s of sessions) {
        if (admitted >= 2) break;
        if (!s.cwd) continue;
        const cwd = norm(s.cwd);
        if (normWorkspaces.some(wp => cwd === wp || cwd.startsWith(wp + path.sep.toLowerCase()))) {
          recentFallbackIds.add(s.sessionId);
          admitted++;
        }
      }
    }

    const filtered = sessions.filter(s => {
      if (!s.cwd) return false;
      if (!activeIds.has(s.sessionId) && !storedIds.has(s.sessionId) && !recentFallbackIds.has(s.sessionId)) return false;
      const cwd = norm(s.cwd);
      return normWorkspaces.some(wp =>
        cwd === wp || cwd.startsWith(wp + path.sep.toLowerCase()),
      );
    });
    return filtered;
  }

  private async fetchRecentClaudeSessions(): Promise<SidebarState['claudeSessions']> {
    try {
      const res = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/claude-sessions/recent?limit=50`);
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
      const res = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/claude-sessions/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        const creds = loadCredentials();
        if (creds?.deviceId) {
          await SessionStore.add(this._context, creds.deviceId, sessionId);
        }
        vscode.window.showInformationMessage(`Session ${sessionId.slice(0, 8)} pushed to remote`);
      } else {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        vscode.window.showErrorMessage(`Attach failed: ${(body as Record<string, unknown>).error || res.statusText}`);
      }
    } catch {
      vscode.window.showErrorMessage('Attach failed: bridge not available');
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
    const STALE_APPROVAL_MS = 5 * 60_000; // skip approvals older than 5min
    for (const [sid, evts] of Object.entries(events)) {
      const session = sessions.find(s => s.id === sid);
      for (const e of evts) {
        if (e.pending && e.type === 'approval_required') {
          // Skip stale pending events that should have been expired by the relay cleanup
          const age = Date.now() - new Date(e.created_at).getTime();
          if (age > STALE_APPROVAL_MS) continue;
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

      // Collect all events, sort newest first, skip resolved and stale approvals
      const allEvts = agentSessions.flatMap(s => (events[s.id] || []))
        .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      const activeEvent = allEvts.find(e => {
        if (e.type !== 'approval_required') return true;
        if (e.pending === false || ['approve', 'deny', 'expired'].includes(e.decision ?? '')) return false;
        // Skip stale pending events (older than 5min)
        if (Date.now() - new Date(e.created_at).getTime() > 5 * 60_000) return false;
        return true;
      });

      let statusLine: string | undefined;
      let lastMessage: string | undefined;

      if (activeEvent) {
        switch (activeEvent.type) {
          case 'approval_required':
            statusLine = 'Awaiting approval';
            break;
          case 'task_complete':
            statusLine = 'Task complete';
            lastMessage = activeEvent.data?.summary;
            break;
          case 'session_idle':
            statusLine = 'Waiting for instruction';
            break;
          default:
            statusLine = 'Running...';
        }
      } else {
        statusLine = 'Idle';
      }

      return { ...a, runtimeStatus: 'active' as const, statusLine, lastMessage };
    });

    // Check bridge capabilities + attached sessions
    let canDetach = false;
    let attachedSessions: string[] = [];
    try {
      const healthResp = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/health`);
      if (healthResp.ok) {
        const health = await healthResp.json() as { supports?: string[] };
        canDetach = health.supports?.includes('detach-session') ?? false;
      }
    } catch {}

    if (canDetach) {
      try {
        const attResp = await fetch(`${this._bridgeService.getBridgeUrl()}/v1/attached-sessions`);
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

    // Load stored (attached) sessions — these persist in the list even when CC exits
    const storedSessions = creds?.deviceId
      ? SessionStore.getByDevice(this._context, creds.deviceId)
      : [];
    const storedIds = new Set(storedSessions.map(s => s.claudeSessionId));

    // Auto-detach: if user closed all CC terminals (transition from open→closed),
    // clean up attached sessions so they don't linger in the list.
    const hasCcRunning = this._checkCcRunning();
    if (this._hadCcRunning && !hasCcRunning && storedSessions.length > 0) {
      for (const s of storedSessions) {
        this._autoDetachSession(s.claudeSessionId);
      }
    }
    this._hadCcRunning = hasCcRunning;

    // Fetch local transcript sessions and overlay relay titles where available
    const recentSessions = await this.fetchRecentClaudeSessions();
    const activeIds = await this._fetchActiveSessionIds();
    const filteredSessions = this._filterLocalSessions(recentSessions, activeIds, storedIds, hasCcRunning);

    // Restore stored sessions whose transcript files have been cleaned up
    const recentIds = new Set(recentSessions.map(s => s.sessionId));
    for (const stored of storedSessions) {
      if (!recentIds.has(stored.claudeSessionId)) {
        filteredSessions.push({
          sessionId: stored.claudeSessionId,
          cwd: stored.cwd || '',
          title: stored.title || stored.claudeSessionId,
          transcriptPath: '',
          createdAt: stored.updatedAt,
          updatedAt: stored.updatedAt,
        });
      }
    }

    const mergedClaudeSessions = filteredSessions.map(s => ({
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
      case 'relayReconnect':
        fetch(`${this._bridgeService.getBridgeUrl()}/v1/relay-reconnect`, { method: 'POST' }).catch(() => {});
        vscode.window.showInformationMessage('Relay reconnecting...');
        break;
      case 'refreshClaudeSessions':
        this._pushState();
        break;
      case 'attachClaudeSession':
        this.attachClaudeSession(msg.sessionId).then(() => this._pushState());
        break;
      case 'getSessionPreview':
        this._handleSessionPreview(msg.sessionId);
        break;
      case 'toggleAttachClaudeSession':
        if (msg.attached) {
          // Already attached — detach
          fetch(`${this._bridgeService.getBridgeUrl()}/v1/detach-session`, {
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
      case 'detachSession':
        fetch(`${this._bridgeService.getBridgeUrl()}/v1/detach-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claudeSessionId: msg.sessionId }),
        }).then(async (res) => {
          if (res.ok) {
            const creds = loadCredentials();
            if (creds?.deviceId) {
              await SessionStore.remove(this._context, creds.deviceId, msg.sessionId);
            }
          }
          this._pushState();
        });
        break;
    }
  }

  private async _handleSessionPreview(sessionId: string): Promise<void> {
    try {
      const entries = loadConversation(sessionId, 50);
      this._view?.webview.postMessage({
        action: 'sessionPreview',
        sessionId,
        entries,
      });
    } catch {
      this._view?.webview.postMessage({
        action: 'sessionPreview',
        sessionId,
        entries: [],
        error: 'Failed to load conversation',
      });
    }
  }
}
