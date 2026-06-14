import * as vscode from 'vscode';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import WebSocket from 'ws';
import { loadCredentials, clearCredentials, loadDesktopInstallId } from '../auth/credentials.js';
import { createApi, ApiError, type SessionResponse, type EventResponse, type SubscriptionResponse } from '../api/client.js';
import { getAgents } from '../agents/registry.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import { SessionStore } from '../services/session-store.js';
import { isOpenCodeCliInstalled } from '../hook/opencode-installer.js';


import {
  renderSidebar,
  renderDeviceContent,
  renderPairingContent,
  renderAgentsContent,
  renderApprovalsContent,
  renderSessionsContent,
  renderSessionDetailContent,
  renderPrivacyContent,
  renderPrivacyDetailContent,
  renderHistoryPolicyContent,
  renderSubscribe,
  type SidebarState,
  type PendingApprovalItem,
  type PairingState,
} from './sidebar-html.js';
import { loadConversation, loadCodexConversation, normalizeCodexSessionTitle } from '@codekey/shared/bridge';
import { log } from '../log.js';
import { secureFetch } from '../util/secure-fetch.js';
import { generateEcdhKeyPair, computeSharedSecret, deriveKeyMaterial } from '@codekey/shared/bridge';

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-code-hook': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
};

const POLL_MS = 5000;
const APPROVAL_POLL_MS = 1000;
const PRIVACY_POLL_MS = 5000;
const BRIDGE_FETCH_TIMEOUT_MS = 2000;

interface BridgePendingApproval {
  id: string;
  serverEventId?: string;
  serverSessionId: string;
  claudeSessionId: string;
  agentType: string;
  command: string;
  summary: string;
  toolName: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
  createdAt: number;
}

function agentDisplayName(agentType?: string, fallback?: string): string {
  if (agentType && AGENT_DISPLAY_NAMES[agentType]) return AGENT_DISPLAY_NAMES[agentType];
  return fallback || agentType || 'Claude Code';
}

function openCodeSessionTitle(session: any): string {
  const candidates = [
    session?.title,
    session?.name,
    session?.metadata?.title,
    session?.info?.title,
    session?.info?.name,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== 'string') continue;
    const title = candidate.trim();
    if (!title || /^ses_/.test(title) || title === session?.id) continue;
    return title;
  }
  return 'OpenCode session';
}

function codexSessionTitle(session: any, remote?: { title?: string; metadata?: Record<string, unknown> }): string {
  const localTitle = normalizeCodexSessionTitle(session?.title);
  if (localTitle) return localTitle;

  const remoteTitle = normalizeCodexSessionTitle(remote?.title);
  if (remoteTitle) return remoteTitle;

  const metadataTitle = normalizeCodexSessionTitle((remote?.metadata as Record<string, unknown> | undefined)?.title);
  if (metadataTitle) return metadataTitle;

  return session?.sessionId ? String(session.sessionId).slice(0, 8) : 'Codex session';
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'codekey.sidebar';

  private _view?: vscode.WebviewView;
  private _pollTimer?: ReturnType<typeof setInterval>;
  private _approvalPollTimer?: ReturnType<typeof setInterval>;
  private _bridgeService = BridgeStatusService.getInstance();
  private _bridgeDisposable?: vscode.Disposable;
  private _hadCcRunning = false;
  private _pairingState: PairingState | undefined = undefined;
  private _selectedPairingPlatform: 'wechat' | 'feishu' | 'telegram' = 'telegram';
  private _firstPush = true;
  private _bridgeApprovals: BridgePendingApproval[] = [];
  private _bridgeSupportsPendingApprovals = false;
  private _lastApprovalSig = '';
  private _pairingWs?: WebSocket;
  private _pairingTimeout?: ReturnType<typeof setTimeout>;
  private _ecdhPrivateKey?: Buffer;
  private _claudeAttachInFlight = new Set<string>();
  private _opencodeAttachInFlight = new Set<string>();
  private _codexStaleStopInFlight = new Set<string>();
  /** Sessions currently being synced/unsynced — shown as spinner in UI. */
  private _syncInFlight = new Set<string>();
  /** Debounce rapid sync/unsync toggles — 1s between actions. */
  private _lastToggleTime = 0;
  /** Track recent user-initiated detach actions. The remote session list
   *  may take a few seconds to reflect the detach (relay processes the
   *  WS deactivate_session async). During this window, ignore the
   *  `remote` fallback so the UI updates immediately. */
  private _recentDetachedAt = new Map<string, number>();
  /** Track recent user-initiated attach actions. The remote session list
   *  may take a few seconds to include the newly-registered session.
   *  During this window, treat the session as attached even if remote
   *  doesn't have it yet — bridge has authoritatively registered it. */
  private _recentAttachedAt = new Map<string, number>();
  private _pushInFlight = false;
  private _pushQueued = false;
  private _approvalPollInFlight = false;
  /** Consecutive 404 responses from bridge /v1/pending-approvals. After 5,
   *  fall back to a 30s retry interval instead of 1s polling. */
  private _approvalPoll404Count = 0;
  private _approvalPollRetryTimer?: ReturnType<typeof setTimeout>;
  private _privacyPollTimer?: ReturnType<typeof setInterval>;
  private _lastPrivacySig = '';
  private _privacyStats: any = null;
  private _lastSubscription?: SubscriptionResponse;
  private _lastEvents: Record<string, EventResponse[]> = {};
  private _lastRelaySessions: SessionResponse[] = [];
  private _lastClaudeSessions: SidebarState['claudeSessions'] = [];
  private _lastAgents: SidebarState['agents'] = [];

  /** Window during which a recent user-driven detach/attach overrides
   *  the lagging `remote` list. Long enough to absorb the WS round-trip
   *  + DB write + next sidebar poll, short enough that a real out-of-band
   *  re-attach (mp re-syncs from phone) still wins after the window. */
  private static readonly RECENT_ACTION_WINDOW_MS = 15_000;
  private static readonly MIN_SYNC_SPINNER_MS = 600;

  private _isRecentlyDetached(sessionId: string): boolean {
    const at = this._recentDetachedAt.get(sessionId);
    if (!at) return false;
    if (Date.now() - at > SidebarProvider.RECENT_ACTION_WINDOW_MS) {
      this._recentDetachedAt.delete(sessionId);
      return false;
    }
    return true;
  }

  private _isRecentlyAttached(sessionId: string): boolean {
    const at = this._recentAttachedAt.get(sessionId);
    if (!at) return false;
    if (Date.now() - at > SidebarProvider.RECENT_ACTION_WINDOW_MS) {
      this._recentAttachedAt.delete(sessionId);
      return false;
    }
    return true;
  }

  private _syncStatus(sessionId: string): SidebarState['claudeSessions'][number]['syncStatus'] | undefined {
    if (this._syncInFlight.has(sessionId)) return 'syncing';
    return undefined;
  }

  private _decorateSyncStatus(sessions: SidebarState['claudeSessions']): SidebarState['claudeSessions'] {
    return sessions.map((session) => {
      const { syncStatus: _syncStatus, ...rest } = session;
      const syncStatus = this._syncStatus(session.sessionId);
      return syncStatus ? { ...rest, syncStatus } : rest;
    });
  }

  private _finishSyncSpinner(sessionId: string, startedAt: number): void {
    const waitMs = Math.max(0, SidebarProvider.MIN_SYNC_SPINNER_MS - (Date.now() - startedAt));
    setTimeout(() => {
      this._syncInFlight.delete(sessionId);
      this._pushSessionsOnly();
    }, waitMs);
  }

  constructor(private _context: vscode.ExtensionContext) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    log('SidebarProvider.resolveWebviewView called');
    this._view = webviewView;
    this._firstPush = true;

    webviewView.webview.options = { enableScripts: true };
    // Immediate placeholder so the user never sees a blank panel
    webviewView.webview.html = '<!DOCTYPE html><html><body style="background:#0f0f18;color:#e8e8f0;padding:20px;font-family:sans-serif;font-size:13px">Loading CodeKey...</body></html>';
    webviewView.webview.onDidReceiveMessage((msg) => this._onMessage(msg));

    this._bridgeDisposable = this._bridgeService.onDidChange(() => this._pushState());

    webviewView.onDidDispose(() => {
      this._view = undefined;
      this._lastPrivacySig = '';
      this._stopPolling();
      this._stopApprovalPolling();
      this._stopPrivacyPolling();
      if (this._bridgeDisposable) {
        this._bridgeDisposable.dispose();
        this._bridgeDisposable = undefined;
      }
    });

    this._bridgeService.ensureStarted();
    this._pushState().catch(err => log(`_pushState (initial) failed: ${err?.stack || err}`));
    this._startPolling();
    this._startApprovalPolling();
    this._startPrivacyPolling();
  }

  /** Fast (1s) poll of bridge's in-memory pending approvals.
   *  Avoids the 5s relay round-trip — approvals appear in sidebar within ~1s
   *  of the CC permission dialog instead of 0–5s. */
  private async _pollBridgeApprovals(): Promise<void> {
    if (!this._view) return;
    if (this._approvalPollInFlight) return;
    this._approvalPollInFlight = true;
    try {
      const resp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/pending-approvals`);
      if (!resp.ok) {
        if (resp.status === 404) {
          this._approvalPoll404Count++;
          // Immediately fall back to _pushStateInner's relay fallback
          this._bridgeSupportsPendingApprovals = false;
          if (this._approvalPoll404Count >= 5) {
            // 5 consecutive 404s — stop busy-polling, retry after 30s
            this._stopApprovalPolling();
            this._approvalPollRetryTimer = setTimeout(() => {
              this._approvalPoll404Count = 0;
              this._startApprovalPolling();
            }, 30_000);
          }
        }
        return;
      }
      this._approvalPoll404Count = 0;
      this._bridgeSupportsPendingApprovals = true;
      const body = await resp.json() as { approvals?: BridgePendingApproval[] };
      const next = body.approvals ?? [];
      // Cheap dedup: only push state when the set of ids actually changes
      const sig = next.map(a => a.id).sort().join('|');
      if (sig === this._lastApprovalSig) return;
      this._lastApprovalSig = sig;
      this._bridgeApprovals = next;
      // Push approval-only state to webview immediately (decoupled from full state sync).
      // This ensures approvals render even if _pushStateInner (relay-dependent) fails.
      if (this._view) {
        const pendingApprovals: PendingApprovalItem[] = next.map(a => ({
          id: a.id,
          serverEventId: a.serverEventId,
          agentType: a.agentType,
          command: a.command || '(unknown)',
          summary: a.summary || a.command || '(unknown)',
          toolName: a.toolName || '',
          agent: agentDisplayName(a.agentType),
          risk: a.risk,
          serverSessionId: a.serverSessionId,
        }));
        this._view.webview.postMessage({
          type: 'stateUpdate',
          approvalsHtml: renderApprovalsContent({
            deviceStatus: 'paired',
            phoneName: '',
            bridge: this._bridgeService.state,
            agents: [],
            pendingApprovals,
            sessions: [],
            events: {},
            claudeSessions: [],
          }),
          approvalCount: pendingApprovals.length,
        });
      }
      this._pushState().catch(err => log(`_pushState (approval-driven) failed: ${err?.stack || err}`));
    } catch {
      // bridge unreachable, leave previous state
    } finally {
      this._approvalPollInFlight = false;
    }
  }

  private async _pollPrivacy(): Promise<void> {
    if (!this._view) return;
    try {
      const resp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/privacy-stats`);
      if (!resp.ok) return;
      const stats = await resp.json() as { summary: { forwarded: number; blocked: number; sanitized: number; totalFindings: number }; recentEntries: any[] };
      this._privacyStats = stats;
      const sig = stats.summary.forwarded + '|' + stats.summary.blocked + '|' + stats.summary.sanitized + '|' + stats.recentEntries.length;
      if (sig === this._lastPrivacySig) return;
      this._lastPrivacySig = sig;
      const state: SidebarState = {
        deviceStatus: 'paired',
        phoneName: '',
        bridge: this._bridgeService.state,
        agents: [],
        pendingApprovals: [],
        sessions: [],
        events: {},
        claudeSessions: [],
        privacy: stats,
      };
      this._view.webview.postMessage({ type: 'stateUpdate', privacyHtml: renderPrivacyContent(state) });
    } catch {
      // bridge unreachable — leave previous state
    }
  }

  /** Fetch active claudeSessionIds from bridge (sessions with CC tabs). */
  private async _fetchActiveSessionIds(): Promise<Set<string>> {
    try {
      const resp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/active-sessions`);
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

  /** Check if Codex is available (official VS Code extension). */
  private _checkCodexAvailable(): boolean {
    const codexExt = vscode.extensions.getExtension('openai.chatgpt');
    return codexExt?.isActive === true;
  }

  /** Auto-detach a session (called when user closes the CC terminal). */
  private async _autoDetachSession(claudeSessionId: string): Promise<void> {
    try {
      const res = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/detach-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ claudeSessionId }),
      });
      if (res.ok) {
        this._recentDetachedAt.set(claudeSessionId, Date.now());
        this._recentAttachedAt.delete(claudeSessionId);
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

  private async _autoStopStaleCodexSession(sessionId: string): Promise<void> {
    if (this._codexStaleStopInFlight.has(sessionId)) return;
    this._codexStaleStopInFlight.add(sessionId);
    try {
      await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/codex-sessions/stop`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      log(`_autoStopStaleCodexSession: cleared stale resume ${sessionId.slice(0, 8)}`);
    } catch (err) {
      log(`_autoStopStaleCodexSession failed for ${sessionId.slice(0, 8)}: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this._codexStaleStopInFlight.delete(sessionId);
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
      const res = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/claude-sessions/recent?limit=50`);
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

  private async attachClaudeSession(sessionId: string): Promise<boolean> {
    if (!sessionId) return false;
    if (this._claudeAttachInFlight.has(sessionId)) {
      log(`Claude attach already in flight for ${sessionId.slice(0, 8)}`);
      return false;
    }
    this._claudeAttachInFlight.add(sessionId);
    try {
      const res = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/claude-sessions/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      });
      if (res.ok) {
        this._recentAttachedAt.set(sessionId, Date.now());
        this._recentDetachedAt.delete(sessionId);
        const creds = loadCredentials();
        if (creds?.deviceId) {
          await SessionStore.add(this._context, creds.deviceId, sessionId).catch((storeErr) => {
            log(`SessionStore.add failed (non-fatal): ${storeErr instanceof Error ? storeErr.message : String(storeErr)}`);
          });
        }
        vscode.window.showInformationMessage(`Session ${sessionId.slice(0, 8)} pushed to remote`);
        return true;
      } else {
        const body = await res.json().catch(() => ({} as Record<string, unknown>));
        vscode.window.showErrorMessage(`Attach failed: ${(body as Record<string, unknown>).error || res.statusText}`);
        return false;
      }
    } catch {
      vscode.window.showErrorMessage('Attach failed: bridge not available');
      return false;
    } finally {
      this._claudeAttachInFlight.delete(sessionId);
    }
  }

  private async _pushState(): Promise<void> {
    if (!this._view) return;
    if (this._pushInFlight) {
      this._pushQueued = true;
      return;
    }
    this._pushInFlight = true;
    try {
      await this._pushStateInner();
    } catch (err: any) {
      log(`_pushState failed: ${err?.stack || err}`);
      // Push approval state only (data already in memory, no relay calls needed)
      if (this._bridgeApprovals.length > 0) {
        try {
          await this._pushStateApprovalsOnly();
        } catch {}
      }
      if (this._view && this._firstPush) {
        this._view.webview.html = `<!DOCTYPE html><html><body style="background:#0f0f18;color:#e8e8f0;padding:20px;font-family:sans-serif;font-size:12px"><h3 style="color:#f74d4d">CodeKey error</h3><pre style="white-space:pre-wrap;word-break:break-word;font-size:11px">${String(err?.stack || err).replace(/&/g,'&amp;').replace(/</g,'&lt;')}</pre></body></html>`;
        this._firstPush = false;
      }
    } finally {
      this._pushInFlight = false;
      if (this._pushQueued) {
        this._pushQueued = false;
        void this._pushState();
      }
    }
  }

  /** Push only the approvals section to the webview, skipping full state sync.
   *  Used as a fallback when _pushStateInner fails (relay/credentials unavailable)
   *  but we have approval data in memory from the bridge. */
  private async _pushStateApprovalsOnly(): Promise<void> {
    if (!this._view) return;
    const pendingApprovals: PendingApprovalItem[] = this._bridgeApprovals.map(a => ({
      id: a.id,
      serverEventId: a.serverEventId,
      agentType: a.agentType,
      command: a.command || '(unknown)',
      summary: a.summary || a.command || '(unknown)',
      toolName: a.toolName || '',
      agent: agentDisplayName(a.agentType),
      risk: a.risk,
      serverSessionId: a.serverSessionId,
    }));
    this._view.webview.postMessage({
      type: 'stateUpdate',
      approvalsHtml: renderApprovalsContent({
        deviceStatus: 'unpaired',
        phoneName: '',
        bridge: this._bridgeService.state,
        agents: [],
        pendingApprovals,
        sessions: [],
        events: {},
        claudeSessions: [],
      }),
      approvalCount: pendingApprovals.length,
    });
  }

  /** Push only session list state — marks in-flight sync buttons with spinner.
   *  Skips relay API calls for speed; uses in-memory session + syncInFlight data. */
  private _pushSessionsOnly(): void {
    if (!this._view) return;
    const claudeSessions = this._decorateSyncStatus(this._lastClaudeSessions);
    // Build a minimal state with current _syncInFlight markers. The webview
    // swaps only sessionsContent, leaving other sections unchanged.
    const creds = loadCredentials();
    const state: SidebarState = {
      lang: vscode.env.language,
      deviceStatus: creds?.deviceToken ? 'paired' : 'unpaired',
      phoneName: '',
      bridge: this._bridgeService.state,
      agents: this._lastAgents,
      pendingApprovals: [],
      sessions: [],
      events: {},
      claudeSessions,
    };
    this._view.webview.postMessage({
      type: 'stateUpdate',
      sessionsHtml: renderSessionsContent(state),
    });
  }

  private _pushUnpairedDeviceState(): void {
    if (!this._view) return;
    const state: SidebarState = {
      lang: vscode.env.language,
      deviceStatus: 'unpaired',
      phoneName: '',
      bridge: this._bridgeService.state,
      agents: [],
      pendingApprovals: [],
      sessions: [],
      events: {},
      claudeSessions: [],
      pairingPlatform: this._selectedPairingPlatform,
    };
    this._view.webview.postMessage({
      type: 'stateUpdate',
      deviceHtml: renderDeviceContent(state),
      pairingHtml: renderPairingContent(state),
      deviceStatus: 'unpaired',
      paired: false,
      relayUrl: '',
      deviceId: '',
      deviceSecret: '',
      pairingStatus: 'idle',
    });
  }

  private _bridgeFetch(url: string, init: RequestInit = {}): Promise<Response> {
    return fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(BRIDGE_FETCH_TIMEOUT_MS),
    });
  }

  private async _pushStateInner(): Promise<void> {
    if (!this._view) return;

    const creds = loadCredentials();
    const bridge = this._bridgeService.state;
    // Default to 'paired' when we have stored credentials — the bridge WS
    // health check may lag behind actual connection state. Starting with
    // 'unpaired' due to stale health data would briefly flash the pairing UI.
    let deviceStatus: SidebarState['deviceStatus'] =
      creds?.deviceToken ? 'paired' : 'unpaired';
    let sessions: SessionResponse[] = [];
    let allDeviceSessions: SessionResponse[] = [];
    let allDeviceSessionsFresh = false;
    let events: Record<string, any[]> = {};
    let pendingApprovals: SidebarState['pendingApprovals'] = [];

    let subscription: SubscriptionResponse | undefined;
    if (creds?.deviceToken) {
      try {
        const api = createApi(creds);
        const windowId = vscode.env.sessionId;
        sessions = await api.getSessions(windowId);
        try {
          allDeviceSessions = await api.getSessions();
          allDeviceSessionsFresh = true;
        } catch {
          allDeviceSessions = sessions;
        }
        await Promise.all(sessions.map(async (s) => {
          events[s.id] = await api.getSessionEvents(s.id).catch(() => []);
        }));
        deviceStatus = 'paired';
        this._lastEvents = events;
        this._lastRelaySessions = sessions;
        subscription = await api.getDeviceSubscription().catch(() => this._lastSubscription);
        if (subscription) this._lastSubscription = subscription;
      } catch (err) {
        // Device status is purely credential-based; relay reachability is
        // communicated via the green dot in renderDeviceContent.
      }
    }
    if (allDeviceSessions.length === 0) allDeviceSessions = sessions;

    // ── History policies ──────────────────────────────
    type HistoryPolicyEntry = { key: string; policy: string; updatedAt: number };
    let historyPolicies: HistoryPolicyEntry[] = [];
    try {
      const hpResp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/history-policies`);
      if (hpResp.ok) {
        const raw = (await hpResp.json()) as Array<{ key: string; config: { policy: string; updatedAt: number } }>;
        historyPolicies = raw.map(r => ({ key: r.key, ...r.config }));
      }
    } catch { /* bridge unreachable */ }

    // Pending approvals: prefer bridge's in-memory list (real-time, ~1s lag),
    // fall back to relay events scrape for older bridges that lack the endpoint.
    if (this._bridgeSupportsPendingApprovals) {
      for (const a of this._bridgeApprovals) {
        const session = sessions.find(s => s.id === a.serverSessionId);
        pendingApprovals.push({
          id: a.id,
          serverEventId: a.serverEventId,
          agentType: a.agentType,
          command: a.command || '(unknown)',
          summary: a.summary || a.command || '(unknown)',
          toolName: a.toolName || '',
          agent: agentDisplayName(a.agentType, session?.agent_type),
          risk: a.risk,
          serverSessionId: a.serverSessionId,
        });
      }
    } else {
      const STALE_APPROVAL_MS = 5 * 60_000;
      for (const [sid, evts] of Object.entries(events)) {
        const session = sessions.find(s => s.id === sid);
        for (const e of evts) {
          if (e.pending && e.type === 'approval_required') {
            const age = Date.now() - new Date(e.created_at).getTime();
            if (age > STALE_APPROVAL_MS) continue;
            pendingApprovals.push({
              id: e.id,
              serverEventId: e.id,
              agentType: session?.agent_type || '',
              command: e.data?.command ?? '(unknown)',
              summary: e.data?.summary ?? e.data?.command ?? '(unknown)',
              toolName: e.data?.toolName ?? '',
              agent: agentDisplayName(session?.agent_type),
              risk: e.risk_level ?? 'medium',
              serverSessionId: sid,
            });
          }
        }
      }
    }

    // Local-running probes
    const ccLocallyRunning = this._checkCcRunning();
    const codexAvailable = this._checkCodexAvailable();
    let _opencodeCliInstalled: boolean | null = null;
    const opencodeCliInstalled = () => {
      if (_opencodeCliInstalled !== null) return _opencodeCliInstalled;
      try { _opencodeCliInstalled = isOpenCodeCliInstalled(); } catch { _opencodeCliInstalled = false; }
      return _opencodeCliInstalled;
    };

    // Determine runtime agent status
    const agentIntegrations: Record<string, 'enabled' | 'not_found'> = {
      'claude-code': bridge.hookConfig !== 'not_found' ? 'enabled' : 'not_found',
      'codex': bridge.codexHook,
      'opencode': bridge.opencodePlugin,
    };
    const agents = getAgents().map(a => {
      if (a.status !== 'available') return { ...a, runtimeStatus: 'unavailable' as const, integrationStatus: 'not_found' as const };
      const agentSessions = sessions.filter(s => a.sessionAgentTypes.includes(s.agent_type));
      const defaultInteg = agentIntegrations[a.id] || 'not_found';
      if (agentSessions.length === 0) {
        // No relay session — but for Claude Code, count it active if a local
        // terminal / official extension panel is open.
        if (a.id === 'claude-code' && ccLocallyRunning) {
          return { ...a, runtimeStatus: 'active' as const, integrationStatus: defaultInteg, statusLine: 'Running locally' };
        }
        if (a.id === 'codex' && codexAvailable) {
          return { ...a, runtimeStatus: 'active' as const, integrationStatus: defaultInteg };
        }
        if (a.id === 'opencode' && opencodeCliInstalled()) {
          return { ...a, runtimeStatus: 'active' as const, integrationStatus: defaultInteg, ...(defaultInteg === 'not_found' ? { canInstall: true as const } : {}) };
        }
        return { ...a, runtimeStatus: 'idle' as const, integrationStatus: defaultInteg };
      }

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

      return { ...a, runtimeStatus: 'active' as const, statusLine, lastMessage, integrationStatus: agentIntegrations[a.id] || 'not_found', ...(a.id === 'opencode' && (agentIntegrations[a.id] || 'not_found') === 'not_found' && opencodeCliInstalled() ? { canInstall: true as const } : {}) };
    });

    // Check bridge capabilities + attached sessions
    let canDetach = false;
    let attachedSessions: string[] = [];
    try {
      const healthResp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/health`);
      if (healthResp.ok) {
        const health = await healthResp.json() as { supports?: string[] };
        canDetach = health.supports?.includes('detach-session') ?? false;
      }
    } catch {}

    if (canDetach) {
      try {
        const attResp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/attached-sessions`);
        if (attResp.ok) {
          const attBody = await attResp.json() as { attached?: string[] };
          attachedSessions = attBody.attached ?? [];
        }
      } catch {}
    }

    // Build lookup: claudeSessionId → relay session title (synced tab label).
    // Only use sessions from THIS window — using allSessions (no windowId)
    // would cause a label change on one session to bleed into every other
    // local session that shares the same window.
    const relayTitleByClaudeSessionId = new Map<string, string>();
    for (const s of sessions) {
      const csid = s.metadata?.claudeSessionId;
      const title = s.metadata?.title;
      if (csid && title) {
        relayTitleByClaudeSessionId.set(csid, title);
      }
    }
    const remoteOpenCodeByLocalId = new Map<string, { serverSessionId: string; title?: string }>();
    const remoteCodexByLocalId = new Map<string, { serverSessionId: string; title?: string }>();
    for (const s of allDeviceSessions) {
      const localId = s.metadata?.claudeSessionId || s.metadata?.localSessionId;
      if (!localId) continue;
      if (s.agent_type === 'codex') {
        remoteCodexByLocalId.set(localId, {
          serverSessionId: s.id,
          title: s.metadata?.title,
        });
        continue;
      }
      if (s.agent_type !== 'opencode') continue;
      const title = openCodeSessionTitle({ id: localId, metadata: s.metadata });
      remoteOpenCodeByLocalId.set(localId, {
        serverSessionId: s.id,
        ...(title !== 'OpenCode session' ? { title } : {}),
      });
    }

    // Load stored (attached) sessions — these persist in the list even when CC exits
    const storedSessions = creds?.deviceId
      ? SessionStore.getByDevice(this._context, creds.deviceId)
      : [];
    const storedIds = new Set(storedSessions.map(s => s.claudeSessionId));

    // Auto-detach: if user closed all CC terminals (transition from open→closed),
    // clean up attached sessions so they don't linger in the list.
    const hasCcRunning = ccLocallyRunning;
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

    // Restore stored OpenCode sessions that aren't already in the live API list
    const ocStored = creds?.deviceId
      ? SessionStore.getOpenCodeByDevice(this._context, creds.deviceId)
      : [];
    for (const oc of ocStored) {
      filteredSessions.push({
        sessionId: oc.claudeSessionId,
        cwd: oc.cwd || '',
        title: oc.title || 'OpenCode session',
        transcriptPath: '',
        createdAt: oc.updatedAt,
        updatedAt: oc.updatedAt,
      });
    }

    const mergedClaudeSessions = filteredSessions.map(s => ({
      ...s,
      title: relayTitleByClaudeSessionId.get(s.sessionId) || s.title,
      attached: attachedSessions.includes(s.sessionId) && !this._isRecentlyDetached(s.sessionId),
      canDetach: canDetach,
    }));

    // Mark stored opencode sessions — sessionStore keeps history, bridge decides attached
    const ocStoredIds = new Set(ocStored.map(s => s.claudeSessionId));
    for (const s of mergedClaudeSessions) {
      if (ocStoredIds.has(s.sessionId)) {
        const remote = remoteOpenCodeByLocalId.get(s.sessionId);
        const bridgeAttached = attachedSessions.includes(s.sessionId);
        // Authoritative: if bridge says attached, it's attached. If bridge
        // says not attached AND user recently detached, honor the user
        // action (relay sessions list lags ~1-5s). Otherwise fall back to
        // remote so bridge-restart scenarios still show attached state.
        const isAttached = bridgeAttached
          || (this._isRecentlyAttached(s.sessionId))
          || (!!remote && !this._isRecentlyDetached(s.sessionId));
        (s as any).isOpenCodeSession = true;
        (s as any).attached = isAttached;
        (s as any).canDetach = isAttached;
        if (remote) {
          (s as any).serverSessionId = remote.serverSessionId;
          if (remote.title) (s as any).title = remote.title;
        }
      }
    }

    // Inject the bridge-known active session if it's not already in the list.
    // This covers: session just started (transcript not written yet), transcript
    // cleaned up, or session in a different project directory.
    try {
      const windowId = vscode.env.sessionId;
      const resp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/window-active-session?windowId=${encodeURIComponent(windowId)}`);
      if (resp.ok) {
        const body = await resp.json() as { claudeSessionId?: string | null };
        const activeCsid = body.claudeSessionId;
        if (activeCsid && !mergedClaudeSessions.some(s => s.sessionId === activeCsid)) {
          const title = relayTitleByClaudeSessionId.get(activeCsid) || activeCsid.slice(0, 8);
          const cwd = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
          mergedClaudeSessions.unshift({
            sessionId: activeCsid,
            title,
            cwd,
            updatedAt: new Date().toISOString(),
            attached: attachedSessions.includes(activeCsid),
            canDetach,
          });
        }
      }
    } catch { /* bridge unreachable — skip injection */ }

    // ── Codex Resume sessions ───────────────────────────
    try {
      const wsPath = vscode.workspace.workspaceFolders?.[0]?.uri?.fsPath || '';
      const codexResp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/codex-sessions${wsPath ? `?cwd=${encodeURIComponent(wsPath)}` : ''}`);
      if (codexResp.ok) {
        const codexBody = await codexResp.json() as { sessions?: any[] };
        if (codexBody.sessions) {
          const existingIds = new Set(mergedClaudeSessions.map(s => s.sessionId));
          for (const cs of codexBody.sessions) {
            if (existingIds.has(cs.sessionId)) continue;
            existingIds.add(cs.sessionId);
            const remote = remoteCodexByLocalId.get(cs.sessionId);
            const bridgeAttached = attachedSessions.includes(cs.sessionId);
            // Authoritative: bridge attached → attached. Recent user attach
            // (relay sessions list lags) → attached. Otherwise fall back to
            // remote only when not recently detached, mirroring OpenCode.
            //
            // Auto-stop stale resume sessions only when:
            //   - relay's full session list is fresh
            //   - bridge thinks attached
            //   - remote has no record
            //   - user hasn't taken a recent attach action (so we don't
            //     race-kill a just-started resume before relay observes it)
            const isAttached = bridgeAttached
              || this._isRecentlyAttached(cs.sessionId)
              || (!!remote && !this._isRecentlyDetached(cs.sessionId));
            if (
              allDeviceSessionsFresh
              && bridgeAttached
              && !remote
              && !this._isRecentlyAttached(cs.sessionId)
            ) {
              this._autoStopStaleCodexSession(cs.sessionId);
            }
            mergedClaudeSessions.push({
              sessionId: cs.sessionId,
              title: codexSessionTitle(cs, remote),
              cwd: cs.cwd || '',
              updatedAt: cs.updatedAt || '',
              attached: isAttached,
              canDetach: isAttached,
              isCodexSession: true,
              resumed: isAttached,
              serverSessionId: remote?.serverSessionId,
            });
          }
        }
      }
    } catch { /* bridge unreachable */ }

    // ── OpenCode sessions ───────────────────────────────
    try {
      const ocResp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/opencode-sessions`);
      if (ocResp.ok) {
        const ocBody = await ocResp.json() as { sessions?: any[] };
        if (ocBody.sessions) {
          for (const s of ocBody.sessions) {
            if (!s.id) continue;
            const remote = remoteOpenCodeByLocalId.get(s.id);
            const bridgeAttached = attachedSessions.includes(s.id);
            const isAttached = bridgeAttached
              || this._isRecentlyAttached(s.id)
              || (!!remote && !this._isRecentlyDetached(s.id));
            const item = {
              sessionId: s.id,
              title: openCodeSessionTitle(s),
              cwd: s.directory || '',
              updatedAt: s.time?.updated ? new Date(s.time.updated).toISOString() : '',
              attached: isAttached,
              canDetach: isAttached,
              isOpenCodeSession: true,
              serverSessionId: remote?.serverSessionId,
            };
            const existing = mergedClaudeSessions.find(ms => ms.sessionId === s.id);
            if (existing) {
              Object.assign(existing, item);
              continue;
            }
            mergedClaudeSessions.push(item);
          }
        }
      }
    } catch { /* bridge unreachable */ }

    // Dedup by sessionId — multiple sources (ocStored, listSessions HTTP+disk,
    // allDeviceSessions) can produce duplicates if session IDs diverge or the
    // same session appears from different discovery paths. Keep the last entry
    // which has the freshest metadata from the live API.
    {
      const seen = new Map<string, typeof mergedClaudeSessions[0]>();
      for (const s of mergedClaudeSessions) {
        seen.set(s.sessionId, s);
      }
      if (seen.size !== mergedClaudeSessions.length) {
        mergedClaudeSessions.length = 0;
        mergedClaudeSessions.push(...seen.values());
      }
    }

    // Save for _pushSessionsOnly (lightweight spinner update without API calls)
    this._lastClaudeSessions = mergedClaudeSessions;
    this._lastAgents = agents;
    const visibleClaudeSessions = this._decorateSyncStatus(mergedClaudeSessions);

    const state: SidebarState = {
      lang: vscode.env.language,
      deviceStatus,
      phoneName: 'WeChat Mini Program',
      bridge,
      agents,
      pendingApprovals,
      sessions,
      events,
      claudeSessions: visibleClaudeSessions,
      relayUrl: creds?.relayUrl,
      deviceId: creds?.deviceId,
      deviceSecret: creds?.deviceSecret,
      feishuAppId: vscode.workspace.getConfiguration('codekey').get<string>('feishuAppId', ''),
      pairingPlatform: this._pairingState?.platform || creds?.platform || this._selectedPairingPlatform,
      pairing: this._pairingState,
      subscription,
      historyPolicies,
    };

    if (this._firstPush) {
      this._view.webview.html = renderSidebar(state);
      this._firstPush = false;
    } else {
    this._view.webview.postMessage({
      type: 'stateUpdate',
      deviceHtml: renderDeviceContent(state),
      pairingHtml: renderPairingContent(state),
      agentsHtml: renderAgentsContent(state),
      approvalsHtml: renderApprovalsContent(state),
      sessionsHtml: renderSessionsContent(state),
      subscriptionHtml: renderSubscribe(state),
      historyPolicyHtml: renderHistoryPolicyContent(state),
      deviceStatus,
      paired: deviceStatus === 'paired',
      agentCount: state.agents.filter(a => a.runtimeStatus === 'active').length,
      approvalCount: state.pendingApprovals.length,
      relayUrl: state.relayUrl ?? '',
      deviceId: state.deviceId ?? '',
      deviceSecret: state.deviceSecret ?? '',
      pairingStatus: state.pairing?.status || 'idle',
    });
  }
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

  private _startApprovalPolling(): void {
    this._stopApprovalPolling();
    this._approvalPollTimer = setInterval(() => this._pollBridgeApprovals(), APPROVAL_POLL_MS);
  }

  private _stopApprovalPolling(): void {
    if (this._approvalPollRetryTimer) {
      clearTimeout(this._approvalPollRetryTimer);
      this._approvalPollRetryTimer = undefined;
    }
    if (this._approvalPollTimer) {
      clearInterval(this._approvalPollTimer);
      this._approvalPollTimer = undefined;
    }
  }

  private _startPrivacyPolling(): void {
    this._stopPrivacyPolling();
    this._privacyPollTimer = setInterval(() => this._pollPrivacy(), PRIVACY_POLL_MS);
  }

  private _stopPrivacyPolling(): void {
    if (this._privacyPollTimer) {
      clearInterval(this._privacyPollTimer);
      this._privacyPollTimer = undefined;
    }
  }

  private _onMessage(msg: any): void {
    switch (msg.action) {
      case 'pair':
        vscode.commands.executeCommand('codekey.pairDevice');
        break;
      case 'relayReconnect':
        this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/relay-reconnect`, { method: 'POST' }).catch(() => {});
        vscode.window.showInformationMessage('Relay reconnecting...');
        break;
      case 'install-opencode':
        vscode.commands.executeCommand('codekey.enableOpenCode');
        break;
      case 'toggle-codex-hook':
        vscode.commands.executeCommand('codekey.toggleCodexHook');
        break;
      case 'refreshClaudeSessions':
        this._view?.webview.postMessage({
          type: 'sessionsRefreshStatus',
          text: vscode.env.language.startsWith('zh') ? '刷新中...' : 'Refreshing...',
        });
        this._pushState().finally(() => {
          this._view?.webview.postMessage({
            type: 'sessionsRefreshStatus',
            text: vscode.env.language.startsWith('zh') ? '已刷新' : 'Refreshed',
          });
          setTimeout(() => {
            this._view?.webview.postMessage({
              type: 'sessionsRefreshStatus',
              text: '',
            });
          }, 1200);
        });
        break;
      case 'attachClaudeSession':
        this.attachClaudeSession(msg.sessionId).then(() => this._pushState());
        break;
      case 'getSessionPreview':
        if (msg.isopencode) {
          this._handleOpenCodePreview(msg.sessionId);
          break;
        }
        this._handleSessionPreview(msg.sessionId, msg.iscodex === true);
        break;
      case 'showSessionDetail':
        this._handleShowSessionDetail(msg.serverSessionId, msg.sessionId);
        break;
      case 'hideSessionDetail':
        break;
      case 'showPrivacyDetail':
        this._handleShowPrivacyDetail(msg.filter);
        break;
      case 'hidePrivacyDetail':
        if (this._privacyStats) {
          const state: SidebarState = {
            lang: vscode.env.language,
            deviceStatus: 'paired',
            phoneName: '',
            bridge: this._bridgeService.state,
            agents: [],
            pendingApprovals: [],
            sessions: [],
            events: {},
            claudeSessions: [],
            historyPolicies: [],
            privacy: this._privacyStats,
          };
          this._view?.webview.postMessage({ type: 'stateUpdate', privacyHtml: renderPrivacyContent(state) });
        }
        break;
      case 'toggleAttachClaudeSession':
        // Debounce: ignore actions within 1s of the last toggle to prevent
        // relay race conditions (deactivate_session vs register_session).
        if (Date.now() - this._lastToggleTime < 1000) { log('toggle debounced'); break; }
        this._lastToggleTime = Date.now();
        const toggleSid = String(msg.sessionId || '');
        const syncStartedAt = Date.now();
        if (toggleSid) this._syncInFlight.add(toggleSid);
        this._pushSessionsOnly();
        if (msg.isopencode) {
          const sessionId = String(msg.sessionId || '');
          const attached = msg.attached === true;
          if (!sessionId) {
            vscode.window.showErrorMessage('OpenCode attach failed: missing session id');
            this._finishSyncSpinner(toggleSid, syncStartedAt);
            break;
          }

          const op = attached ? 'detach' : 'attach';
          const inFlightKey = `${op}:${sessionId}`;
          if (this._opencodeAttachInFlight.has(inFlightKey)) {
            log(`OpenCode ${op} already in flight for ${sessionId.slice(0, 8)}`);
            break;
          }
          this._opencodeAttachInFlight.add(inFlightKey);
          const ocUrl = attached
            ? `${this._bridgeService.getBridgeUrl()}/v1/opencode-sessions/detach`
            : `${this._bridgeService.getBridgeUrl()}/v1/opencode-sessions/attach`;
          this._bridgeFetch(ocUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sessionId, title: msg.title || '', serverSessionId: msg.serverSessionId || '' }),
          }).then(async (res) => {
            if (!res.ok) {
              const body = await res.json().catch(() => ({} as Record<string, unknown>));
              vscode.window.showErrorMessage(`${attached ? 'Detach' : 'Attach'} failed: ${(body as Record<string, unknown>).error || res.statusText}`);
            } else {
              if (attached) {
                this._recentDetachedAt.set(sessionId, Date.now());
                this._recentAttachedAt.delete(sessionId);
              } else {
                this._recentAttachedAt.set(sessionId, Date.now());
                this._recentDetachedAt.delete(sessionId);
              }
              const creds = loadCredentials();
              if (creds?.deviceId) {
                if (!attached) {
                  await SessionStore.addOpenCode(this._context, creds.deviceId, sessionId, { title: msg.title || '', cwd: '' });
                } else {
                  await SessionStore.removeOpenCode(this._context, creds.deviceId, sessionId);
                }
              }
            }
          }).catch(() => {
            vscode.window.showErrorMessage(`${attached ? 'Detach' : 'Attach'} failed: bridge not available`);
          }).finally(() => {
            this._opencodeAttachInFlight.delete(inFlightKey);
            this._finishSyncSpinner(toggleSid, syncStartedAt);
            this._pushState();
          });
          break;
        }
        if (msg.iscodex) {
          // Codex session: Attach = start resume, Detach = stop resume
          const codexSid = String(msg.sessionId || '');
          const bridgeUrl = this._bridgeService.getBridgeUrl();
          if (msg.attached) {
            // Detach: look up serverSessionId from active sessions so the relay
            // always gets a deactivate_session even if the bridge restarted and
            // lost its in-memory localToServer map.
            interface ActiveSession { localSession: { sessionId: string }; serverSessionId: string }
            this._bridgeFetch(`${bridgeUrl}/v1/codex-sessions/active`)
              .then(activeResp => activeResp.ok ? activeResp.json() as Promise<{ sessions: ActiveSession[] }> : Promise.resolve({ sessions: [] }))
              .catch((): { sessions: ActiveSession[] } => ({ sessions: [] }))
              .then((activeBody) => {
                const match = activeBody.sessions?.find(s => s.localSession.sessionId === codexSid);
                const serverSessionId = match?.serverSessionId || '';
                return this._bridgeFetch(`${bridgeUrl}/v1/codex-sessions/stop`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ sessionId: codexSid, serverSessionId }),
                });
              })
              .then(async (res) => {
                if (!res.ok) {
                  const body = await res.json().catch(() => ({} as Record<string, unknown>));
                  vscode.window.showErrorMessage(`Stop failed: ${(body as Record<string, unknown>).error || res.statusText}`);
                } else if (codexSid) {
                  this._recentDetachedAt.set(codexSid, Date.now());
                  this._recentAttachedAt.delete(codexSid);
                }
                this._finishSyncSpinner(toggleSid, syncStartedAt);
                this._pushState();
              })
              .catch(() => {
                this._finishSyncSpinner(toggleSid, syncStartedAt);
                vscode.window.showErrorMessage('Stop failed: bridge not available');
              });
          } else {
            this._bridgeFetch(`${bridgeUrl}/v1/codex-sessions/resume`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ sessionId: codexSid }),
            }).then(async (res) => {
              if (!res.ok) {
                const body = await res.json().catch(() => ({} as Record<string, unknown>));
                vscode.window.showErrorMessage(`Resume failed: ${(body as Record<string, unknown>).error || res.statusText}`);
              } else if (codexSid) {
                this._recentAttachedAt.set(codexSid, Date.now());
                this._recentDetachedAt.delete(codexSid);
              }
              this._finishSyncSpinner(toggleSid, syncStartedAt);
              this._pushState();
            }).catch(() => {
              this._finishSyncSpinner(toggleSid, syncStartedAt);
              vscode.window.showErrorMessage('Resume failed: bridge not available');
            });
          }
        } else if (msg.attached) {
          // Already attached — detach from relay and forget the explicit sync.
          this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/detach-session`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ claudeSessionId: msg.sessionId }),
          }).then(async (res) => {
            if (!res.ok) {
              vscode.window.showErrorMessage(`Detach failed: ${res.statusText}`);
            } else {
              this._recentDetachedAt.set(msg.sessionId, Date.now());
              this._recentAttachedAt.delete(msg.sessionId);
              const creds = loadCredentials();
              if (creds?.deviceId) {
                await SessionStore.remove(this._context, creds.deviceId, msg.sessionId);
              }
            }
            this._finishSyncSpinner(toggleSid, syncStartedAt);
            this._pushState();
          }).catch(() => {
            this._finishSyncSpinner(toggleSid, syncStartedAt);
            this._pushState();
          });
        } else {
          this.attachClaudeSession(msg.sessionId).then((succeeded) => {
            this._finishSyncSpinner(toggleSid, syncStartedAt);
            this._pushState();
          });
        }
        break;
      case 'detachSession':
        this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/detach-session`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claudeSessionId: msg.sessionId }),
        }).then(async (res) => {
          if (res.ok) {
            this._recentDetachedAt.set(msg.sessionId, Date.now());
            this._recentAttachedAt.delete(msg.sessionId);
            const creds = loadCredentials();
            if (creds?.deviceId) {
              await SessionStore.remove(this._context, creds.deviceId, msg.sessionId);
            }
          }
          this._pushState();
        });
        break;
      case 'regeneratePairingCode':
        this._handlePairingGenerate();
        break;
      case 'switchPlatform':
        this._selectedPairingPlatform = msg.platform === 'wechat' ? 'wechat'
          : msg.platform === 'feishu' ? 'feishu'
          : 'telegram';
        if (this._pairingState) {
          this._pairingState.platform = this._selectedPairingPlatform;
          this._pairingState.method = this._selectedPairingPlatform === 'telegram' ? 'qr' : 'code';
        }
        this._pushState();
        break;
      case 'platformPair':
        this._selectedPairingPlatform = msg.platform === 'wechat' ? 'wechat'
          : msg.platform === 'feishu' ? 'feishu'
          : 'telegram';
        this._handlePairingGenerate();
        break;
      case 'pairedDevice':
        this._handlePairingComplete(msg.token, msg.deviceId);
        break;
      case 'redeemCode':
        this._handleRedeemCode(msg.code);
        break;
      case 'unpairDevice':
        this._handleUnpair();
        break;
      case 'setHistoryPolicy':
        this._handleSetHistoryPolicy(msg.key, msg.policy);
        break;
      case 'deleteHistoryPolicy':
        this._handleDeleteHistoryPolicy(msg.key);
        break;
    }
  }

  private async _handleUnpair(): Promise<void> {
    this._closePairingSocket();
    const creds = loadCredentials();
    let localOnly = false;
    if (creds?.deviceToken) {
      try {
        const res = await secureFetch(`${creds.relayUrl}/api/v1/devices/${creds.deviceId}`, {
          method: 'DELETE',
          headers: { 'Authorization': `Bearer ${creds.deviceToken}` },
          signal: AbortSignal.timeout(5000),
        });
        if (!res.ok) {
          let message = res.statusText || `HTTP ${res.status}`;
          try {
            const body = await res.json() as { error?: string };
            message = body.error || message;
          } catch {
            // Keep the HTTP status message when the response body is not JSON.
          }
          throw new Error(message);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'server request failed';
        // Token already revoked or device already deleted — or server returned
        // an error (Electron raw TLS parsing may misrepresent HTTP status codes).
        // Server-side state is already clean in all these cases: proceed with
        // local cleanup without blocking the user.
        localOnly = true;
      }
    }
    clearCredentials();
    this._pairingState = undefined;
    this._selectedPairingPlatform = 'telegram';
    this._pushUnpairedDeviceState();
    void this._pushState();
    vscode.window.showInformationMessage('Device unpaired');
  }

  private async _handleRedeemCode(code: string): Promise<void> {
    const creds = loadCredentials();
    if (!creds) {
      this._postRedeemResult(false, 'Not paired');
      return;
    }
    try {
      const res = await secureFetch(`${creds.relayUrl}/api/v1/device-redeem`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${creds.deviceToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: code.trim().toUpperCase() }),
        signal: AbortSignal.timeout(10000),
      });
      const body = await res.json() as { error?: string; success?: boolean; afterExpiresAt?: string };
      if (res.ok && body.success) {
        this._postRedeemResult(true, body.afterExpiresAt || '');
        this._pushState();
      } else {
        this._postRedeemResult(false, body.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Request failed';
      this._postRedeemResult(false, msg);
    }
  }

  private _postRedeemResult(ok: boolean, detail: string): void {
    this._view?.webview.postMessage({ type: 'redeemResult', ok, error: detail });
  }

  private async _handlePairingGenerate(): Promise<void> {
    const relayUrl = 'https://codekey.tinymoney.cn';
    const existingCreds = loadCredentials();
    const desktopInstallId = loadDesktopInstallId();
    let deviceSecret = existingCreds?.deviceSecret || crypto.randomUUID();

    // Generate ECDH keypair for E2E encryption
    const ecdhKeyPair = generateEcdhKeyPair();
    this._ecdhPrivateKey = ecdhKeyPair.privateKey;

    const requestPair = (deviceId?: string) => {
      const deviceSecretHash = crypto.createHash('sha256').update(deviceSecret).digest('hex');
      return secureFetch(`${relayUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(deviceId ? { deviceId } : {}),
          desktopInstallId,
          deviceSecretHash,
          deviceName: `VS Code (${os.hostname()})`,
          publicKeyHex: ecdhKeyPair.publicKeyHex,
        }),
        signal: AbortSignal.timeout(10000),
      });
    };
    try {
      let resp = await requestPair(existingCreds?.deviceId);
      if ((resp.status === 403 || resp.status === 404) && existingCreds?.deviceId) {
        log(`pairing existing device rejected (${resp.status}); creating a fresh device`);
        clearCredentials();
        deviceSecret = crypto.randomUUID();
        resp = await requestPair();
      }
      if (!resp.ok) {
        const detail = await resp.text().catch(() => '');
        const statusText = resp.status === 429 ? 'Pairing rate limited. Try again later.' : `Pairing failed${detail ? `: ${detail}` : ''}`;
        this._pairingState = { code: '', method: (this._pairingState?.platform || this._selectedPairingPlatform) === 'telegram' ? 'qr' : 'code', platform: this._pairingState?.platform || this._selectedPairingPlatform, status: 'error', statusText, expiresAt: 0 };
        this._pushState();
        return;
      }
      const result = await resp.json() as { code: string; deviceId: string; expiresIn?: number; pairUrl?: string };

      const platform = this._pairingState?.platform || this._selectedPairingPlatform;
      // E2E key generation: WeChat (QR carries key via codekey:// URL),
      // Telegram (user manually enters key). Feishu not in scope yet.
      const contentKeyHex = platform !== 'feishu' ? crypto.randomBytes(32).toString('hex') : '';
      const keyId = contentKeyHex ? contentKeyHex.slice(0, 16) : '';
      let pairUrl = result.pairUrl || '';
      if (platform === 'wechat') {
        pairUrl = `codekey://pair?code=${result.code}&key_id=${keyId}&content_key=${contentKeyHex}&v=1`;
      }

      const { saveCredentials } = await import('../auth/credentials.js');
      saveCredentials({ deviceId: result.deviceId, deviceSecret, relayUrl });
      await BridgeStatusService.getInstance().stop({ force: true });
      this._openPairingSocket(result.deviceId, deviceSecret, relayUrl);
      this._pairingState = {
        code: String(result.code),
        method: platform === 'telegram' ? 'qr' : 'code',
        platform,
        status: 'waiting',
        statusText: 'Waiting for scan...',
        expiresAt: Date.now() + (result.expiresIn ?? 300) * 1000,
        pairUrl,
        contentKeyHex,
        keyId,
      };
      this._pushState();
    } catch (err) {
      const msg = (err as Error).message;
      log(`pairing generate failed: ${msg}`);
      this._pairingState = { code: '', method: (this._pairingState?.platform || this._selectedPairingPlatform) === 'telegram' ? 'qr' : 'code', platform: this._pairingState?.platform || this._selectedPairingPlatform, status: 'error', statusText: `Connection failed: ${msg}`, expiresAt: 0 };
      this._pushState();
      vscode.window.showErrorMessage(`CodeKey: pairing failed — ${msg}`);
    }

  }

  private _closePairingSocket(): void {
    if (this._pairingTimeout) {
      clearTimeout(this._pairingTimeout);
      this._pairingTimeout = undefined;
    }
    if (this._pairingWs) {
      const ws = this._pairingWs;
      this._pairingWs = undefined;
      try { ws.close(); } catch {}
    }
  }

  private _openPairingSocket(deviceId: string, deviceSecret: string, relayUrl: string): void {
    this._closePairingSocket();
    const wsUrl = `${relayUrl.replace(/^http/, 'ws')}/ws?device_id=${encodeURIComponent(deviceId)}&device_secret=${encodeURIComponent(deviceSecret)}`;
    const ws = new WebSocket(wsUrl, { rejectUnauthorized: false });
    this._pairingWs = ws;

    this._pairingTimeout = setTimeout(() => {
      if (this._pairingWs !== ws) return;
      log('Pairing socket timed out');
      this._closePairingSocket();
      this._pairingState = {
        code: this._pairingState?.code || '',
        method: (this._pairingState?.platform || this._selectedPairingPlatform) === 'telegram' ? 'qr' : 'code',
        platform: this._pairingState?.platform || this._selectedPairingPlatform,
        status: 'error',
        statusText: 'Pairing timed out',
        expiresAt: 0,
      };
      this._pushState();
    }, 5 * 60 * 1000);

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as {
          type?: string;
          payload?: { deviceToken?: string; deviceId?: string; phonePublicKeyHex?: string; e2eAvailable?: boolean };
          deviceToken?: string;
          token?: string;
          deviceId?: string;
        };
        if (msg.type === 'pairing_ready') {
          const prev = this._pairingState;
          this._pairingState = {
            code: prev?.code || '',
            method: (prev?.platform || this._selectedPairingPlatform) === 'telegram' ? 'qr' : 'code',
            platform: prev?.platform || this._selectedPairingPlatform,
            status: 'waiting',
            statusText: 'Code accepted. Waiting for confirmation...',
            expiresAt: prev?.expiresAt || Date.now() + 5 * 60 * 1000,
            pairUrl: prev?.pairUrl,
            contentKeyHex: prev?.contentKeyHex,
            keyId: prev?.keyId,
          };
          this._pushState();
        }
        if (msg.type === 'device_token') {
          const token = msg.payload?.deviceToken || msg.deviceToken || msg.token;
          const nextDeviceId = msg.payload?.deviceId || msg.deviceId;
          this._handlePairingComplete(token, nextDeviceId, msg.payload?.phonePublicKeyHex);
        }
      } catch (err) {
        log(`Pairing socket message parse failed: ${err}`);
      }
    });

    ws.on('error', (err) => {
      log(`Pairing socket error: ${err instanceof Error ? err.message : String(err)}`);
    });

    ws.on('close', () => {
      if (this._pairingWs === ws) {
        this._pairingWs = undefined;
      }
    });
  }

  private async _handlePairingComplete(token?: string, deviceId?: string, phonePublicKeyHex?: string): Promise<void> {
    this._closePairingSocket();
    if (!token) {
      log('Pairing completed without device token');
      this._pairingState = {
        code: this._pairingState?.code || '',
        method: (this._pairingState?.platform || this._selectedPairingPlatform) === 'telegram' ? 'qr' : 'code',
        platform: this._pairingState?.platform || this._selectedPairingPlatform,
        status: 'error',
        statusText: 'Pairing failed: missing device token',
        expiresAt: 0,
      };
      this._pushState();
      return;
    }

    // Derive ECDH key material if phone sent its public key
    let ecdhKeyHex: string | undefined;
    let ecdhKeyId: string | undefined;
    if (phonePublicKeyHex && this._ecdhPrivateKey) {
      try {
        const sharedSecret = computeSharedSecret(this._ecdhPrivateKey, phonePublicKeyHex);
        const material = deriveKeyMaterial(sharedSecret);
        ecdhKeyHex = material.contentKeyHex;
        ecdhKeyId = material.keyId;
      } catch (err) {
        log('[CodeKey] ECDH key exchange failed:', err instanceof Error ? err.message : String(err));
      }
    }
    this._ecdhPrivateKey = undefined;

    const e2eAvailable = !!ecdhKeyHex;

    const creds = loadCredentials();
    if (creds) {
      if (deviceId) creds.deviceId = deviceId;
      creds.deviceToken = token;
      const platform = this._pairingState?.platform;
      if (platform === 'feishu' || platform === 'wechat' || platform === 'telegram') creds.platform = platform;
      if (platform === 'telegram' && !e2eAvailable) {
        delete creds.contentKeyHex;
        delete creds.keyId;
      } else {
        if (this._pairingState?.contentKeyHex) creds.contentKeyHex = this._pairingState.contentKeyHex;
        if (this._pairingState?.keyId) creds.keyId = this._pairingState.keyId;
      }
      if (ecdhKeyHex) creds.ecdhKeyHex = ecdhKeyHex;
      if (ecdhKeyId) creds.ecdhKeyId = ecdhKeyId;
      const { saveCredentials } = await import('../auth/credentials.js');
      saveCredentials(creds);
      BridgeStatusService.getInstance().restart();
      vscode.window.showInformationMessage('Device paired successfully!');
    }
    this._pairingState = {
      code: this._pairingState?.code || '',
      method: (this._pairingState?.platform || this._selectedPairingPlatform) === 'telegram' ? 'qr' : 'code',
      platform: this._pairingState?.platform || this._selectedPairingPlatform,
      status: 'paired',
      statusText: this._pairingState?.platform === 'wechat' ? 'Connected via WeChat'
        : this._pairingState?.platform === 'feishu' ? 'Connected via Feishu'
        : this._pairingState?.platform === 'telegram' && !e2eAvailable ? 'Connected via Telegram (E2E off)'
        : 'Connected via Telegram',
      expiresAt: 0,
    };
    this._pushState();
  }

  private async _handleSessionPreview(sessionId: string, isCodex = false): Promise<void> {
    try {
      let entries: { role: string; text: string; timestamp: string; index: number }[] = [];

      if (isCodex) {
        entries = loadCodexConversation(sessionId, 5).map((e, i) => ({
          role: e.role, text: e.text, timestamp: e.timestamp || '', index: i,
        }));
      } else {
        // Claude: loadConversation
        entries = loadConversation(sessionId, 5).map((e, i) => ({ ...e, index: i }));
      }

      this._view?.webview.postMessage({
        type: 'sessionPreview',
        sessionId,
        entries,
        agentLabel: isCodex ? 'Codex' : 'Claude',
      });
    } catch (err) {
      log(`_handleSessionPreview failed for ${sessionId}: ${err}`);
      this._view?.webview.postMessage({
        type: 'sessionPreview',
        sessionId,
        entries: [],
        error: 'Failed to load conversation',
        agentLabel: isCodex ? 'Codex' : 'Claude',
      });
    }
  }

  private async _handleOpenCodePreview(sessionId: string): Promise<void> {
    try {
      const resp = await this._bridgeFetch(`${this._bridgeService.getBridgeUrl()}/v1/opencode-sessions/preview?id=${encodeURIComponent(sessionId)}`);
      if (!resp.ok) throw new Error(`Bridge returned ${resp.status}`);
      const body = await resp.json() as { entries?: { role: string; text: string; timestamp: string; index: number }[] };
      this._view?.webview.postMessage({
        type: 'sessionPreview',
        sessionId,
        entries: body.entries || [],
        agentLabel: 'OpenCode',
      });
    } catch (err) {
      log(`_handleOpenCodePreview failed for ${sessionId}: ${err}`);
      this._view?.webview.postMessage({
        type: 'sessionPreview',
        sessionId,
        entries: [],
        error: 'Failed to load messages',
        agentLabel: 'OpenCode',
      });
    }
  }

  private _handleShowSessionDetail(serverSessionId: string, _sessionId: string): void {
    const lang = vscode.env.language;
    const claudeSessions: any[] = this._lastClaudeSessions;
    const events = this._lastEvents[serverSessionId] || [];
    const sessions = this._lastRelaySessions;

    // Build a minimal state-like object for the render function
    const miniState: SidebarState = {
      lang,
      deviceStatus: 'paired',
      phoneName: '',
      bridge: {} as any,
      agents: [],
      pendingApprovals: [],
      sessions,
      events: { [serverSessionId]: events },
      claudeSessions,
      historyPolicies: [],
    };

    const html = renderSessionDetailContent(miniState, serverSessionId);
    this._view?.webview.postMessage({ type: 'sessionDetail', serverSessionId, html });
  }

  private _handleShowPrivacyDetail(filter: string): void {
    if (!this._privacyStats) return;
    const lang = vscode.env.language;
    const state: SidebarState = {
      lang,
      deviceStatus: 'paired',
      phoneName: '',
      bridge: this._bridgeService.state,
      agents: [],
      pendingApprovals: [],
      sessions: [],
      events: {},
      claudeSessions: [],
      historyPolicies: [],
      privacy: this._privacyStats,
    };
    const html = renderPrivacyDetailContent(state, filter);
    this._view?.webview.postMessage({ type: 'privacyDetail', html });
  }

  private _handleSetHistoryPolicy(key: string, policy: string): void {
    const bridgeUrl = this._bridgeService.getBridgeUrl();
    if (!bridgeUrl) return;
    this._bridgeFetch(`${bridgeUrl}/v1/history-policy`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key, config: { policy, updatedAt: Date.now() } }),
    }).then(() => this._pushState()).catch((err) => log(`setHistoryPolicy failed: ${err}`));
  }

  private _handleDeleteHistoryPolicy(key: string): void {
    const bridgeUrl = this._bridgeService.getBridgeUrl();
    if (!bridgeUrl) return;
    this._bridgeFetch(`${bridgeUrl}/v1/history-policy?key=${encodeURIComponent(key)}`, {
      method: 'DELETE',
    }).then(() => this._pushState()).catch((err) => log(`deleteHistoryPolicy failed: ${err}`));
  }
}
