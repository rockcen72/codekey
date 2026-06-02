import { randomUUID } from 'node:crypto';
import { RelayClient } from './relay-client.js';
import { CommandQueue } from './command-queue.js';
import {
  resolveClaudeTranscript,
  extractUserPrompts,
  resolveTranscriptCwd,
} from './claude-transcripts.js';
import { discoverLocalSessions } from './codex-local-session-resolver.js';
import { MAX_PROMPT_LENGTH } from '../types.js';
import type { AgentEventPayload, SessionEventMessage } from '../types.js';

interface PhoneCommandFingerprint {
  fingerprint: string;
  recordedAt: number;
}

export interface HookEventBody {
  eventType: 'task_complete' | 'session_idle';
  claudeSessionId?: string;
  codekeyWindowId?: string;
  lastAssistantMessage?: string;
  data: {
    type: 'task_complete';
    summary: string;
    summaryShort?: string;
  } | {
    type: 'session_idle';
    idleMinutes?: number;
  };
}

interface PendingApproval {
  resolve: (value: { approved: boolean }) => void;
  timer: NodeJS.Timeout;
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

/** Public, serializable shape returned by getPendingApprovals(). */
export interface PendingApprovalSnapshot {
  id: string;                // clientEventId (or migrated serverEventId)
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

export interface TrackPendingApprovalInput {
  id: string;
  serverSessionId: string;
  claudeSessionId: string;
  agentType: string;
  command: string;
  summary: string;
  toolName: string;
  risk: 'low' | 'medium' | 'high' | 'critical';
}

interface ApprovalHookBody {
  claudeSessionId?: string;
  codekeyWindowId?: string;
  source?: string; // 'permission_request' from CC hook, empty from restart replay
  rawEvent?: Record<string, unknown>;
}

interface ApprovalText {
  toolName: string;
  command: string;
  summary: string;
}

export class ApprovalBridge {
  readonly commandQueue = new CommandQueue();

  // Startup grace period: reject hook events without explicit windowId
  // during the first N seconds. CC extension restart replays old events
  // from the hook queue — without this guard they flood the bridge.
  private static readonly STALE_EVENT_GRACE_MS = 30_000;
  private _startTime = Date.now();

  private sessions = new Map<string, string>(); // claudeSessionId → serverSessionId
  private inFlightSessions = new Map<string, Promise<string>>(); // claudeSessionId → registering promise
  private registeredClientRequests = new Map<string, (sid: string) => void>(); // clientRequestId → resolve
  private pendingByServerEventId = new Map<string, PendingApproval>();
  private pendingApprovalFingerprints = new Map<string, Promise<{ approved: boolean }>>();
  private primarySessionId: string | null = null;
  private windowLabels = new Map<string, string>(); // windowId → session label (tab title)
  private windowSessions = new Map<string, string>(); // windowId → serverSessionId
  private windowInFlightSessions = new Map<string, Promise<string | null>>(); // windowId → in-flight activation
  private activeWindows = new Map<string, number>(); // windowId → lastSeen timestamp
  private windowToTabIds = new Map<string, string[]>(); // windowIdPrefix → [tabId1, tabId2, ...] (most recent last)
  private claimedTabSessions = new Set<string>(); // tab-level windowIds already bound to a claudeSessionId
  private pendingDeactivations = new Set<string>(); // windowIds to deactivate once in-flight activation completes
  private transcriptAttachedIds = new Set<string>(); // claudeSessionIds attached via attachClaudeSession (for reconciliation)
  private sentPromptKeys = new Set<string>();     // "claudeSessionId:index" — prevents re-attach duplicates
  // Tracks number of phone commands claimed but not yet acknowledged via session_idle.
  // Used to gate task_complete synthesis from session_idle events.
  private pendingPhoneDeliveryCount = new Map<string, number>(); // serverSessionId → count

  // ── Hook event dedup (CC --resume replay guard) ──────────────
  // CC --resume replays historical hook events. Track fingerprints
  // of forwarded events to prevent re-sending old task_complete etc.
  private static readonly HOOK_DEDUP_TTL_MS = 24 * 60 * 60 * 1000;
  private _forwardedHookFingerprints = new Map<string, number>(); // fingerprint → forwardedAt

  // ── Phone command dedup ─────────────────────────────────────
  private static readonly PHONE_COMMAND_DEDUP_MS = 10 * 60 * 1000;
  private static readonly MAX_PHONE_COMMANDS_PER_SESSION = 50;

  private recentPhoneCommandsBySession = new Map<string, PhoneCommandFingerprint[]>();

  /** Shared Set of serverSessionIds handled by CodexResumeManager (command routing guard). */
  private _resumedServerSessionIds: Set<string> | null = null;

  /** Register the shared Set used to route commands away from the Claude command queue.
   *  The Set is owned by CodexResumeManager; its values must be serverSessionIds. */
  registerResumedServerSessionIds(set: Set<string>): void {
    this._resumedServerSessionIds = set;
  }

  /** Codex resumed session IDs — stored separately so reconcileAttachedSessions doesn't touch them. */
  private _codexAttachedIds = new Set<string>();
  private codexLocalIdCache: { expiresAt: number; ids: Set<string> } = { expiresAt: 0, ids: new Set() };

  /** Register a Codex resumed session ID so getAttachedSessionIds() includes it. */
  addCodexAttachedSession(localSessionId: string): void {
    this._codexAttachedIds.add(localSessionId);
  }

  /** Remove a Codex resumed session ID from attached tracking. */
  removeCodexAttachedSession(localSessionId: string): void {
    this._codexAttachedIds.delete(localSessionId);
  }

  private knownCodexLocalSessionIds(): Set<string> {
    const now = Date.now();
    if (now < this.codexLocalIdCache.expiresAt) return this.codexLocalIdCache.ids;
    let ids = new Set<string>();
    try {
      ids = new Set(discoverLocalSessions(100).map((s) => s.sessionId));
    } catch {
      ids = new Set();
    }
    this.codexLocalIdCache = { expiresAt: now + 5000, ids };
    return ids;
  }

  constructor(readonly relay: RelayClient) {
    // Match session_registered by clientRequestId (NOT by once() — prevents race)
    this.relay.on('session_registered', (payload: unknown) => {
      const p = payload as { clientRequestId?: string; sessionId: string };
      if (p.clientRequestId) {
        const resolve = this.registeredClientRequests.get(p.clientRequestId);
        if (resolve) {
          this.registeredClientRequests.delete(p.clientRequestId);
          resolve(p.sessionId);
        }
      }
    });

    // Migrate pendingByServerEventId key from clientEventId → serverEventId.
    // Keep BOTH keys as fallback: if event_ack arrives during a WS reconnect
    // window, the bridge still recognizes approval_forward by either key.
    this.relay.on('event_ack', (payload: unknown) => {
      const ack = payload as { clientEventId?: string | null; serverEventId: string };
      if (ack.clientEventId) {
        const entry = this.pendingByServerEventId.get(ack.clientEventId);
        if (entry) {
          entry.serverEventId = ack.serverEventId;
          this.pendingByServerEventId.set(ack.serverEventId, entry);
          // Keep clientEventId key — don't delete it
        }
      }
    });

    // Resolve pending approval from phone decision (keyed by serverEventId,
    // with clientEventId fallback for WS reconnect edge case).
    this.relay.on('approval_forward', (payload: unknown) => {
      const fwd = payload as { eventId: string; decision: string; clientEventId?: string | null };
      let entry = this.pendingByServerEventId.get(fwd.eventId);
      // Fallback: relay may not know serverEventId if event_ack was lost during WS reconnect
      if (!entry && fwd.clientEventId && fwd.clientEventId !== fwd.eventId) {
        entry = this.pendingByServerEventId.get(fwd.clientEventId);
      }
      if (entry) {
        clearTimeout(entry.timer);
        // Notify relay to mark the event as resolved (pending=false) immediately,
        // so the sidebar's next poll sees the updated state instead of waiting
        // for a hook event to trigger cleanup.
        this._resolveEventOnRelay(fwd.eventId);
        if (fwd.clientEventId && fwd.clientEventId !== fwd.eventId) {
          this._resolveEventOnRelay(fwd.clientEventId);
        }
        // Clean up ALL keys pointing to this entry (clientEventId + serverEventId)
        for (const [key, val] of this.pendingByServerEventId) {
          if (val === entry) this.pendingByServerEventId.delete(key);
        }
        entry.resolve({ approved: fwd.decision === 'approve' });
      }
    });

    // Clear local caches when relay confirms session is deactivated (from any source:
    // mini program detach, bridge deactivate, remote cleanup, etc.)
    this.relay.on('session_deactivated', (payload: unknown) => {
      const p = payload as { sessionId: string };
      if (!p.sessionId) return;

      const deactivatedClaudeSessionIds: string[] = [];

      // Remove from sessions map by serverSessionId
      for (const [csid, ssid] of this.sessions) {
        if (ssid === p.sessionId) {
          deactivatedClaudeSessionIds.push(csid);
          this.sessions.delete(csid);
          if (this.primarySessionId === ssid) {
            this.primarySessionId = null;
          }
        }
      }

      // Clean up windowSessions referencing this sessionId
      for (const [wid, sid] of this.windowSessions) {
        if (sid === p.sessionId) {
          this.windowSessions.delete(wid);
          this.windowLabels.delete(wid);
          this.activeWindows.delete(wid);
          this.claimedTabSessions.delete(wid);
        }
      }

      // Also clean up transcriptAttachedIds for matching claudeSessionIds.
      for (const csid of deactivatedClaudeSessionIds) {
        this.transcriptAttachedIds.delete(csid);
      }
    });
  }

  /** Register a VSCode window so its hook events can be associated with this windowId. */
  registerWindow(windowId: string): void {
    if (windowId) this.activeWindows.set(windowId, Date.now());
  }

  /** Proactively register a session for a VSCode window, before any hook fires.
   *  @param windowId - tab-level ID (e.g. "sessionId_1234567890_abc123")
   *  @param sessionLabel - CC tab title
   *  @param windowIdPrefix - window-level ID (e.g. vscode.env.sessionId) for grouping tabs */
  async activateSession(windowId: string, sessionLabel?: string, windowIdPrefix?: string): Promise<string | null> {
    if (!windowId) return null;

    // Already registered for this window
    const existing = this.windowSessions.get(windowId);
    if (existing) return existing;

    // Deduplicate concurrent activations for the same windowId
    const inFlight = this.windowInFlightSessions.get(windowId);
    if (inFlight) return inFlight;

    const promise = this._activateOnRelay(windowId, sessionLabel).then((sessionId) => {
      this.windowInFlightSessions.delete(windowId);

      if (!sessionId) return null;

      // If deactivation was requested while activation was in-flight, deactivate now.
      // This handles the race: tab opens → activation starts → tab closes → activation completes.
      if (this.pendingDeactivations.has(windowId)) {
        this.pendingDeactivations.delete(windowId);
        console.error('[bridge] activateSession: deactivation was pending for %s, deactivating immediately', windowId);
        this.relay.sendRaw(JSON.stringify({
          type: 'deactivate_session',
          payload: { sessionId },
        }));
        return null;
      }

      this.windowSessions.set(windowId, sessionId);
      if (!this.primarySessionId) this.primarySessionId = sessionId;

      // Store mapping: windowIdPrefix → [tabId1, tabId2, ...]
      if (windowIdPrefix) {
        const tabIds = this.windowToTabIds.get(windowIdPrefix);
        if (!tabIds) {
          this.windowToTabIds.set(windowIdPrefix, [windowId]);
        } else if (!tabIds.includes(windowId)) {
          tabIds.push(windowId);
        }
      }

      // Send any pending label that was set before activation completed
      const pendingLabel = this.windowLabels.get(windowId);
      if (pendingLabel) {
        this.relay.sendRaw(JSON.stringify({
          type: 'update_session_label',
          payload: { sessionId, label: pendingLabel },
        }));
      }

      return sessionId;
    }).catch((err) => {
      this.windowInFlightSessions.delete(windowId);
      throw err;
    });

    this.windowInFlightSessions.set(windowId, promise);
    return promise;
  }

  private _activateOnRelay(windowId: string, sessionLabel?: string): Promise<string | null> {
    const clientRequestId = randomUUID();
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.registeredClientRequests.delete(clientRequestId);
        resolve(null);
      }, 10_000);

      this.registeredClientRequests.set(clientRequestId, (sid: string) => {
        clearTimeout(timer);
        resolve(sid);
      });

      const payload: Record<string, string | null> = {
        clientRequestId,
        windowId,
        source: 'provisional_tab',
      };
      if (sessionLabel) payload.sessionLabel = sessionLabel;

      this.relay.sendRaw(JSON.stringify({
        type: 'activate_window',
        payload,
      }));
    });
  }

  /** Deactivate the session for a given VSCode window (tab closed). */
  async deactivateSession(windowId: string): Promise<void> {
    if (!windowId) return;
    const sessionId = this.windowSessions.get(windowId);
    if (!sessionId) {
      // Session not yet created — if activation is in-flight, mark for deactivation
      // so it gets cleaned up as soon as activation completes.
      if (this.windowInFlightSessions.has(windowId)) {
        this.pendingDeactivations.add(windowId);
        console.error('[bridge] deactivateSession: activation in-flight for %s, marking pending deactivation', windowId);
      }
      return;
    }

    // Fire-and-forget: send deactivate_session to relay, don't wait for ack
    this.relay.sendRaw(JSON.stringify({
      type: 'deactivate_session',
      payload: { sessionId },
    }));

    // Clean up local caches immediately so activateSession can create a new session
    this.windowSessions.delete(windowId);
    for (const [csid, ssid] of this.sessions) {
      if (ssid === sessionId) {
        this.sessions.delete(csid);
      }
    }
    this.windowLabels.delete(windowId);
    this.activeWindows.delete(windowId);
    this.claimedTabSessions.delete(windowId);
    if (this.primarySessionId === sessionId) {
      this.primarySessionId = null;
    }
  }

  /** Deactivate all sessions matching a windowId prefix (fire-and-forget).
   *  Sends deactivate_by_window to relay, which handles both window-level and tab-level sessions. */
  deactivateByWindow(windowIdPrefix: string): void {
    if (!windowIdPrefix) return;
    this.relay.sendRaw(JSON.stringify({
      type: 'deactivate_by_window',
      payload: { windowIdPrefix },
    }));

    // Clean up local caches for matching sessions
    for (const [wid, sid] of this.windowSessions) {
      if (wid === windowIdPrefix || wid.startsWith(windowIdPrefix + '_')) {
        this.windowSessions.delete(wid);
        this.windowLabels.delete(wid);
        this.activeWindows.delete(wid);
        this.claimedTabSessions.delete(wid);
        for (const [csid, ssid] of this.sessions) {
          if (ssid === sid) this.sessions.delete(csid);
        }
        if (this.primarySessionId === sid) this.primarySessionId = null;
      }
    }

    // Clean up windowToTabIds for this prefix
    this.windowToTabIds.delete(windowIdPrefix);
  }

  /** Deactivate all sessions (fire-and-forget). Called when parent process exits. */
  async deactivateAll(): Promise<void> {
    const entries = Array.from(this.windowSessions.entries());
    if (entries.length === 0) return;

    for (const [, sessionId] of entries) {
      this.relay.sendRaw(JSON.stringify({
        type: 'deactivate_session',
        payload: { sessionId },
      }));
    }

    // Give WS messages time to flush
    await new Promise((r) => setTimeout(r, 500));

    // Clear all caches
    this.windowSessions.clear();
    this.sessions.clear();
    this.windowLabels.clear();
    this.activeWindows.clear();
    this.primarySessionId = null;
    this.windowInFlightSessions.clear();
    this.windowToTabIds.clear();
    this.claimedTabSessions.clear();
    this.pendingDeactivations.clear();
  }

  /** Push a label update to the relay for a specific claudeSessionId.
   *  Used on startup to sync CC tab labels with restored sessions — bypasses
   *  the windowSessions mapping which isn't populated for restored sessions. */
  syncSessionLabel(claudeSessionId: string, label: string): void {
    if (!claudeSessionId || !label) return;
    const serverSessionId = this.sessions.get(claudeSessionId);
    if (!serverSessionId) return;
    this.relay.sendRaw(JSON.stringify({
      type: 'update_session_label',
      payload: { sessionId: serverSessionId, label },
    }));
  }

  /** Set a label that will be applied to sessions from the given window.
   *  If the label changes and a session already exists, push the update to the relay
   *  so existing sessions get the new name immediately. */
  setPendingLabel(windowId: string, label: string): void {
    if (!windowId || !label) return;
    const prev = this.windowLabels.get(windowId);
    this.windowLabels.set(windowId, label);
    if (prev !== label) {
      const sessionId = this.windowSessions.get(windowId);
      if (sessionId) {
        this.relay.sendRaw(JSON.stringify({
          type: 'update_session_label',
          payload: { sessionId, label },
        }));
      }
    }
  }

  /** Get the most recently registered active windowId, or undefined. */
  _getActiveWindowId(): string | undefined {
    let best: string | undefined;
    let bestTs = 0;
    for (const [wid, ts] of this.activeWindows) {
      if (ts > bestTs) { best = wid; bestTs = ts; }
    }
    return best;
  }

  /** Ensure a server session exists for the given claudeSessionId.
   *  Uses claudeSessionId as the only canonical key — each CC instance gets its own session.
   *  windowId is forwarded as metadata only, not used for routing heuristic.
   *  @param source - metadata source label ('hook' | 'transcript_attach'), defaults to 'hook'. */
  async ensureSession(claudeSessionId: string, windowId?: string, source?: string): Promise<string> {
    if (!claudeSessionId) {
      throw new Error('ensureSession requires non-empty claudeSessionId');
    }

    const existing = this.sessions.get(claudeSessionId);
    if (existing) {
      if (windowId) this.windowSessions.set(windowId, existing);
      return existing;
    }

    const inFlightExisting = this.inFlightSessions.get(claudeSessionId);
    if (inFlightExisting) return inFlightExisting;

    const promise = this._registerOnRelay(claudeSessionId, windowId, source).then((serverSessionId) => {
      this.sessions.set(claudeSessionId, serverSessionId);
      if (windowId) this.windowSessions.set(windowId, serverSessionId);
      if (!this.primarySessionId) this.primarySessionId = serverSessionId;
      this.inFlightSessions.delete(claudeSessionId);

      // After registration, push the current label to relay so the mini
      // program shows the same title as the sidebar.  _registerOnRelay may
      // have included the label in metadata already, but if syncLabel fired
      // AFTER the hook event (race), the label was missing from the first
      // register_session.  sendRaw is idempotent — the relay merges metadata.
      if (windowId) {
        const label = this.windowLabels.get(windowId);
        if (label) {
          this.relay.sendRaw(JSON.stringify({
            type: 'update_session_label',
            payload: { sessionId: serverSessionId, label },
          }));
        }
      }

      return serverSessionId;
    }).catch((err) => {
      this.inFlightSessions.delete(claudeSessionId);
      throw err;
    });

    this.inFlightSessions.set(claudeSessionId, promise);
    return promise;
  }

  private async _registerOnRelay(claudeSessionId: string, windowId?: string, source?: string): Promise<string> {
    const clientRequestId = randomUUID();
    const transcript = await resolveClaudeTranscript(claudeSessionId).catch(() => null);

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registeredClientRequests.delete(clientRequestId);
        reject(new Error('Session registration timeout'));
      }, 10_000);
      this.registeredClientRequests.set(clientRequestId, (sid: string) => {
        clearTimeout(timer);
        resolve(sid);
      });
      // Title priority: synced tab label > transcript-derived title > omit.
      // Omitting title lets the relay's metadata-merge preserve whatever it
      // already has (from a previous register_session or update_session_label).
      const label = windowId ? this.windowLabels.get(windowId) : undefined;
      const title = label || transcript?.title || undefined;
      const metadata: Record<string, unknown> = {
        claudeSessionId,
        runtime: 'claude-code',
        source: source || 'hook',
        cwd: transcript?.cwd || '',
        lastHookAt: new Date().toISOString(),
      };
      if (title) metadata.title = title;

      const payload: Record<string, unknown> = {
        agentType: 'claude-code-hook',
        claudeSessionId,
        clientRequestId,
        metadata,
      };
      if (windowId) {
        payload.windowId = windowId;
        if (label) payload.sessionLabel = label;
      }
      console.error('[bridge] _registerOnRelay: sending register_session for %s (windowId=%s, source=%s)', claudeSessionId, windowId || '(none)', source || 'hook');
      this.relay.sendRaw(JSON.stringify({
        type: 'register_session',
        payload,
      }));
    });
  }

  /** Forward a PermissionRequest hook event to relay. */
  async handleApproval(body: unknown): Promise<{ approved: boolean }> {
    const payload = body as ApprovalHookBody;
    let claudeSessionId = payload.claudeSessionId ?? '';

    // Fallback: try to extract sessionId from rawEvent using broad field detection
    if (!claudeSessionId && payload.rawEvent) {
      const raw = payload.rawEvent as Record<string, unknown>;
      // Try all plausible field names
      for (const key of Object.keys(raw)) {
        if (key.toLowerCase().includes('session') && typeof raw[key] === 'string' && (raw[key] as string).trim()) {
          claudeSessionId = raw[key] as string;
          console.error('[bridge] handleApproval: resolved claudeSessionId from rawEvent key=%s value=%s', key, claudeSessionId);
          break;
        }
      }
      // Try nested metadata
      if (!claudeSessionId && raw.metadata && typeof raw.metadata === 'object') {
        const meta = raw.metadata as Record<string, unknown>;
        for (const key of Object.keys(meta)) {
          if (key.toLowerCase().includes('session') && typeof meta[key] === 'string' && (meta[key] as string).trim()) {
            claudeSessionId = meta[key] as string;
            console.error('[bridge] handleApproval: resolved claudeSessionId from rawEvent.metadata key=%s', key);
            break;
          }
        }
      }
    }

    if (!claudeSessionId) {
      console.error('[bridge] handleApproval: no claudeSessionId in payload or rawEvent, rawEvent keys=%s', payload.rawEvent ? Object.keys(payload.rawEvent).join(',') : '(none)');
      return { approved: false };
    }

    // Replay guard: approvals from CC --resume replay lack source='permission_request'.
    // Auto-reject them so CC doesn't block on historical events.
    const isPermissionRequest = payload.source === 'permission_request';
    if (!isPermissionRequest) {
      console.error('[bridge] auto-rejecting replay approval (session=%s tool=%s)',
        claudeSessionId, payload.rawEvent?.tool_name || 'unknown');
      return { approved: false };
    }

    const explicitWindowId = payload.codekeyWindowId || '';
    const hasKnownSession = this.sessions.has(claudeSessionId) || this.inFlightSessions.has(claudeSessionId);
    if (!explicitWindowId && !hasKnownSession) {
      if (Date.now() - this._startTime < ApprovalBridge.STALE_EVENT_GRACE_MS) {
        console.error('[bridge] ignoring stale approval without windowId (grace, session=%s)', claudeSessionId);
        return { approved: false };
      }
      const fallback = this._getActiveWindowId();
      if (!fallback) {
        console.error('[bridge] ignoring approval without windowId for unknown session (session=%s)', claudeSessionId);
        return { approved: false };
      }
    }

    // Determine windowId: from hook request body, or fall back to most recent active window
    const windowId = explicitWindowId || this._getActiveWindowId() || '';
    const approvalText = this.approvalText(payload);
    const fingerprint = this.approvalFingerprint(claudeSessionId, windowId, payload);
    const existing = this.pendingApprovalFingerprints.get(fingerprint);
    if (existing) return existing;

    const promise = this._handleApprovalOnce(payload, claudeSessionId, windowId, approvalText)
      .finally(() => {
        this.pendingApprovalFingerprints.delete(fingerprint);
      });
    this.pendingApprovalFingerprints.set(fingerprint, promise);
    return promise;
  }

  private approvalFingerprint(claudeSessionId: string, windowId: string, payload: ApprovalHookBody): string {
    const input = this.toolInput(payload);
    return JSON.stringify({
      claudeSessionId,
      windowId,
      toolName: this.toolName(payload),
      toolInput: this.stableStringify(input),
      prompt: this.promptText(payload.rawEvent),
    });
  }

  private approvalText(payload: ApprovalHookBody): ApprovalText {
    const toolName = this.toolName(payload);
    const input = this.toolInput(payload);
    const rawCommand = input.command;
    const command = typeof rawCommand === 'string' && rawCommand.trim()
      ? rawCommand.trim()
      : this.describeToolInput(toolName, input, this.promptText(payload.rawEvent));

    // Claude Code attaches a human-readable `description` to tool calls; surface
    // it as the summary so the phone shows "what" not just the raw shell command.
    const description = typeof input.description === 'string' ? input.description.trim() : '';

    return {
      toolName,
      command,
      summary: description || command.slice(0, 200),
    };
  }

  /**
   * Mask common secret patterns locally before an approval leaves this machine,
   * so raw keys/passwords never reach the relay DB or the phone. Deterministic,
   * no third-party call.
   */
  private desensitize(text: string): string {
    if (!text) return text;
    return text
      .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
      .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-****')
      .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh_****')
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA****')
      .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1****')
      // user:password@host in connection strings / URLs
      .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, '$1****@')
      // password=... / token: ... / api_key=... style assignments
      .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|auth[_-]?token)(\s*["']?\s*[=:]\s*["']?)([^\s"'&;,]+)/gi, '$1$2****');
  }

  private toolName(payload: ApprovalHookBody): string {
    const event = payload.rawEvent ?? {};
    const name = event.tool_name ?? event.toolName ?? event.tool ?? event.name;
    return typeof name === 'string' && name.trim() ? name.trim() : 'Tool';
  }

  private toolInput(payload: ApprovalHookBody): Record<string, unknown> {
    const event = payload.rawEvent ?? {};
    const candidates = [
      event.tool_input,
      event.toolInput,
      event.input,
      event.parameters,
      event.args,
      event.arguments,
    ];
    for (const value of candidates) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        return value as Record<string, unknown>;
      }
    }
    return {};
  }

  private promptText(event?: Record<string, unknown>): string {
    if (!event) return '';
    for (const key of ['prompt', 'message', 'description', 'reason']) {
      const value = event[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return '';
  }

  private approvalAction(toolName: string): 'run_command' | 'write_file' | 'modify_file' | 'unknown' {
    if (toolName === 'Bash') return 'run_command';
    if (toolName === 'Write') return 'write_file';
    if (toolName === 'Edit' || toolName === 'MultiEdit') return 'modify_file';
    return 'unknown';
  }

  private describeToolInput(toolName: string, input: Record<string, unknown>, prompt: string): string {
    const parts = Object.entries(input)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}: ${this.compactValue(value)}`);

    if (parts.length > 0) return `${toolName}: ${parts.join(', ')}`;
    return prompt ? `${toolName}: ${prompt}` : toolName;
  }

  private compactValue(value: unknown): string {
    const text = typeof value === 'string'
      ? value
      : this.stableStringify(value);
    return text.length > 160 ? `${text.slice(0, 157)}...` : text;
  }

  private stableStringify(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return String(value ?? '');
    }
    if (Array.isArray(value)) {
      return `[${value.map(item => this.stableStringify(item)).join(',')}]`;
    }
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = obj[key];
    }
    return JSON.stringify(sorted);
  }

  private async _handleApprovalOnce(
    payload: ApprovalHookBody,
    claudeSessionId: string,
    windowId: string,
    approvalText: ApprovalText,
  ): Promise<{ approved: boolean }> {

    console.error('[bridge] handleApproval: session=%s, codekeyWindowId=%s, fallback=%s, resolved=%s',
      claudeSessionId, payload.codekeyWindowId || '(none)', this._getActiveWindowId() || '(none)', windowId || '(none)');

    let serverSessionId: string;
    try {
      serverSessionId = await this.ensureSession(claudeSessionId, windowId);
    } catch {
      return { approved: false };
    }

    // Replay latest prompts asynchronously — don't block approval_required
    this.replayUserPrompts(claudeSessionId, serverSessionId).catch(() => {});

    const clientEventId = randomUUID();

    const relayMsg: SessionEventMessage = {
      type: 'event',
      payload: {
        clientEventId,
        sessionId: serverSessionId,
        agent: 'claude-code-hook',
        eventType: 'approval_required',
        data: {
          type: 'approval_required',
          action: this.approvalAction(approvalText.toolName),
          toolName: approvalText.toolName,
          command: this.desensitize(approvalText.command),
          risk: 'medium',
          summary: this.desensitize(approvalText.summary),
        },
        ts: new Date().toISOString(),
      },
    };
    // Attach per-window identifiers so the server can associate this session
    // with the correct VSCode window and display the correct label.
    if (windowId) {
      (relayMsg.payload as Record<string, unknown>).windowId = windowId;
    }
    const label = windowId ? this.windowLabels.get(windowId) : undefined;
    if (label) {
      (relayMsg.payload as Record<string, unknown>).sessionLabel = label;
    }

    this.relay.sendEvent(serverSessionId, relayMsg);

    // Resolve any existing pending approvals for this same session so approvals
    // don't accumulate in the sidebar when the user handles them inline in CC.
    for (const [key, val] of this.pendingByServerEventId) {
      if (val.serverSessionId === serverSessionId) {
        clearTimeout(val.timer);
        this._resolveEventOnRelay(key);
        val.resolve({ approved: false });
        this.pendingByServerEventId.delete(key);
      }
    }

    return new Promise<{ approved: boolean }>((resolve) => {
      const entry: PendingApproval = {
        resolve,
        timer: null as any,
        serverSessionId,
        claudeSessionId,
        agentType: 'claude-code-hook',
        command: approvalText.command,
        summary: approvalText.summary,
        toolName: approvalText.toolName,
        risk: 'medium',
        createdAt: Date.now(),
      };
      // Safety net only — NOT the primary resolution path. An approval stays
      // pending until the phone answers (approval_forward) or CC itself moves
      // past it (task_complete, see handleHookEvent). This long timer only
      // guards against a zombie approval leaking if the CC process dies while
      // blocked. Kept in sync with the server-side PENDING_TTL (app.ts).
      entry.timer = setTimeout(() => {
        // Clean up ALL keys (clientEventId + serverEventId fallback)
        for (const [key, val] of this.pendingByServerEventId) {
          if (val === entry) this.pendingByServerEventId.delete(key);
        }
        // Notify relay to mark the event as resolved (timeout)
        this._resolveEventOnRelay(clientEventId);
        resolve({ approved: false });
      }, 30 * 60_000);
      // Wrap resolve to also notify relay on normal approval_forward resolution
      const originalResolve = resolve;
      entry.resolve = (value) => {
        this._resolveEventOnRelay(clientEventId);
        originalResolve(value);
      };
      this.pendingByServerEventId.set(clientEventId, entry);
    });
  }

  /** Snapshot of currently-awaited approvals. Used by /v1/pending-approvals
   *  so the VS Code sidebar can poll the bridge locally (fast, ~ms) instead
   *  of waiting for the next relay poll cycle. Dedups entries that appear
   *  under both clientEventId and serverEventId keys. */
  getPendingApprovals(): PendingApprovalSnapshot[] {
    const seen = new Set<PendingApproval>();
    const out: PendingApprovalSnapshot[] = [];
    for (const [id, entry] of this.pendingByServerEventId) {
      if (seen.has(entry)) continue;
      seen.add(entry);
      out.push({
        id,
        serverEventId: entry.serverEventId,
        serverSessionId: entry.serverSessionId,
        claudeSessionId: entry.claudeSessionId,
        agentType: entry.agentType,
        command: entry.command,
        summary: entry.summary,
        toolName: entry.toolName,
        risk: entry.risk,
        createdAt: entry.createdAt,
      });
    }
    return out;
  }

  trackPendingApproval(input: TrackPendingApprovalInput): () => void {
    const existing = this.pendingByServerEventId.get(input.id);
    if (existing) {
      clearTimeout(existing.timer);
      this.pendingByServerEventId.delete(input.id);
    }

    const entry: PendingApproval = {
      resolve: () => {},
      timer: setTimeout(() => {
        this.pendingByServerEventId.delete(input.id);
      }, 30 * 60_000),
      serverEventId: undefined,
      serverSessionId: input.serverSessionId,
      claudeSessionId: input.claudeSessionId,
      agentType: input.agentType,
      command: input.command,
      summary: input.summary,
      toolName: input.toolName,
      risk: input.risk,
      createdAt: Date.now(),
    };
    this.pendingByServerEventId.set(input.id, entry);

    return () => {
      const current = this.pendingByServerEventId.get(input.id);
      if (current !== entry) return;
      clearTimeout(entry.timer);
      this.pendingByServerEventId.delete(input.id);
    };
  }

  /** Notify relay that an approval event has been resolved (approved/denied/timeout).
   *  Relay marks the event as pending=false so the mini program stops showing it. */
  private _resolveEventOnRelay(eventId: string): void {
    try {
      this.relay.sendRaw(JSON.stringify({
        type: 'resolve_event',
        payload: { eventId },
      }));
    } catch {
      // best-effort, don't block on failure
    }
  }

  /** Forward non-approval hook event (task_complete, session_idle) to relay. */
  async handleHookEvent(body: HookEventBody): Promise<void> {
    const claudeSessionId = body.claudeSessionId ?? '';
    if (!claudeSessionId) return;

    const explicitWindowId = body.codekeyWindowId || '';
    const hasKnownSession = this.sessions.has(claudeSessionId) || this.inFlightSessions.has(claudeSessionId);
    if (!explicitWindowId && !hasKnownSession) {
      if (Date.now() - this._startTime < ApprovalBridge.STALE_EVENT_GRACE_MS) {
        console.error('[bridge] ignoring stale hook event without windowId (grace, event=%s, session=%s)',
          body.eventType, claudeSessionId);
        return;
      }
      console.error('[bridge] ignoring hook event without windowId for unknown session (event=%s, session=%s)',
        body.eventType, claudeSessionId);
      return;
    }

    // Determine windowId: explicit hook window first; fallback is only allowed
    // after this bridge already knows the Claude session.
    const windowId = explicitWindowId || this._getActiveWindowId() || '';

    console.error('[bridge] handleHookEvent(%s): session=%s, codekeyWindowId=%s, fallback=%s, resolved=%s',
      body.eventType, claudeSessionId, body.codekeyWindowId || '(none)', this._getActiveWindowId() || '(none)', windowId || '(none)');

    let serverSessionId: string;
    try {
      serverSessionId = await this.ensureSession(claudeSessionId, windowId);
    } catch {
      console.error('[bridge] no session for hook event (claudeSessionId=%s)', claudeSessionId);
      return;
    }

    const data: AgentEventPayload = body.data.type === 'task_complete'
      ? { type: 'task_complete', summary: body.data.summary ?? '', summaryShort: body.data.summaryShort ?? '' }
      : { type: 'session_idle', idleMinutes: body.data.idleMinutes ?? 0 };

    const relayMsg: SessionEventMessage = {
      type: 'event',
      payload: {
        sessionId: serverSessionId,
        agent: 'claude-code-hook',
        eventType: body.eventType,
        data,
        ts: new Date().toISOString(),
      },
    };

    // Dedup: CC --resume replays historical hook events. Skip if we've
    // already forwarded an event with identical content for this session.
    const hookFp = `${serverSessionId}|${body.eventType}|${JSON.stringify(data)}`;
    const lastForwarded = this._forwardedHookFingerprints.get(hookFp);
    if (lastForwarded && Date.now() - lastForwarded < ApprovalBridge.HOOK_DEDUP_TTL_MS) {
      console.error('[bridge] ignoring duplicate hook event (fp match, event=%s session=%s)',
        body.eventType, claudeSessionId);
      return;
    }
    this._forwardedHookFingerprints.set(hookFp, Date.now());
    // Attach per-window identifiers so the server can associate this session
    // with the correct VSCode window and display the correct label.
    if (windowId) {
      (relayMsg.payload as Record<string, unknown>).windowId = windowId;
    }
    const label = windowId ? this.windowLabels.get(windowId) : undefined;
    if (label) {
      (relayMsg.payload as Record<string, unknown>).sessionLabel = label;
    }

    this.relay.sendEvent(serverSessionId, relayMsg);

    // Clear pending approvals only when CC actually finishes a turn
    // (task_complete) for THIS session. A task_complete means CC ran (or the
    // user answered inline) and moved on, so any approval it was waiting on is
    // resolved — but the bridge never got an approval_forward, so we clean up
    // here. A session_idle must NOT clear: CC goes idle precisely while it is
    // still waiting for the phone to answer, and clearing there would drop a
    // genuinely-pending approval. Scope to serverSessionId so one session's
    // activity never wipes another session's pending approvals.
    if (body.eventType === 'task_complete') {
      for (const [key, entry] of this.pendingByServerEventId) {
        if (entry.serverSessionId !== serverSessionId) continue;
        clearTimeout(entry.timer);
        this._resolveEventOnRelay(key);
        this.pendingByServerEventId.delete(key);
        entry.resolve({ approved: false });
      }
    }

    // Synthesize task_complete from session_idle to surface the assistant's response
    // on the mini program. The notification hook fires session_idle after every
    // CC response — without this synthesis, text-only replies (no tool calls) would
    // be invisible on the phone since session_idle only shows a status message.
    if (body.eventType === 'session_idle' && body.lastAssistantMessage) {
      // Decrement pending phone delivery counter so cross-attach dedup stays accurate
      const pendingCount = this.pendingPhoneDeliveryCount.get(serverSessionId) ?? 0;
      if (pendingCount > 0) {
        this.pendingPhoneDeliveryCount.set(serverSessionId, pendingCount - 1);
      }
      const msg: SessionEventMessage = {
        type: 'event',
        payload: {
          sessionId: serverSessionId,
          agent: 'claude-code-hook',
          eventType: 'task_complete',
          data: {
            type: 'task_complete',
            summary: body.lastAssistantMessage,
            summaryShort: body.lastAssistantMessage.slice(0, 200),
          },
          ts: new Date().toISOString(),
        },
      };
      this.relay.sendEvent(serverSessionId, msg);
    }

    // Note: task_complete does NOT clean up local caches — session lifecycle
    // is managed by activateSession / deactivateSession (VSCode tab close).
  }

  listenRelayCommands(): void {
    this.relay.on('command', (payload: { sessionId?: string; claudeSessionId?: string; action: string; data: string }) => {
      if (payload.action !== 'write_stdin') return;
      if (!payload.sessionId) return;

      // Codex resume routing guard: if this serverSessionId is managed by
      // CodexResumeManager, skip the Claude command queue.
      if (this._resumedServerSessionIds?.has(payload.sessionId)) return;

      const claudeSessionId = payload.claudeSessionId
        ?? Array.from(this.sessions.entries())
            .find(([, serverSessionId]) => serverSessionId === payload.sessionId)?.[0];

      if (claudeSessionId && this.knownCodexLocalSessionIds().has(claudeSessionId)) {
        console.error('[bridge] command dropped: codex session is not resumed, sessionId=%s localSessionId=%s', payload.sessionId, claudeSessionId);
        const errorMsg: SessionEventMessage = {
          type: 'event',
          payload: {
            clientEventId: `codex-not-resumed:${payload.sessionId}:${Date.now()}`,
            sessionId: payload.sessionId,
            agent: 'codex',
            eventType: 'error',
            data: {
              type: 'error',
              message: '该 Codex 会话尚未 Resume，请先在 VS Code 侧边栏点击 Resume 后再从手机发送 prompt',
            },
            ts: new Date().toISOString(),
          },
        };
        this.relay.sendEvent(payload.sessionId, errorMsg);
        return;
      }

      const hasWindowSession = Array.from(this.windowSessions.entries())
        .some(([, serverSessionId]) => serverSessionId === payload.sessionId);

      if (!claudeSessionId && !hasWindowSession) {
        console.error('[bridge] command dropped: no session mapping for sessionId=%s hasWindowSession=%s sessions=%s', payload.sessionId, hasWindowSession, JSON.stringify([...this.sessions.entries()]));
        return;
      }

      // Resolve cwd so command-relay can launch CC in the correct project directory
      const cwd = claudeSessionId ? resolveTranscriptCwd(claudeSessionId) ?? undefined : undefined;
      console.error('[bridge] command queued: sessionId=%s claudeSessionId=%s cwd=%s text=%s', payload.sessionId, claudeSessionId, cwd, payload.data);
      this.commandQueue.push({
        id: randomUUID(),
        sessionId: payload.sessionId,
        claudeSessionId: claudeSessionId ?? undefined,
        cwd,
        text: payload.data,
        source: 'relay:command',
        timestamp: new Date().toISOString(),
      });

      // Emit user_prompt event so the mini program can see the phone command in the conversation.
      // Without this, phone commands only exist in the in-memory command queue and disappear
      // on page refresh — they must be persisted as events in the relay DB.
      const relayMsg: SessionEventMessage = {
        type: 'event',
        payload: {
          clientEventId: `phone:${payload.sessionId}:${Date.now()}`,
          sessionId: payload.sessionId,
          agent: 'claude-code-hook',
          eventType: 'user_prompt',
          data: {
            type: 'user_prompt',
            prompt: payload.data,
            summary: payload.data.slice(0, 200),
          },
          ts: new Date().toISOString(),
        },
      };
      this.relay.sendEvent(payload.sessionId, relayMsg);
    });
  }

  /** Extract recent user prompts from transcript and emit as user_prompt events.
   *  Dedup strategy: sentPromptKeys (cross-attach) + consumePhoneCommandMatch (one-shot per session). */
  private async replayUserPrompts(
    claudeSessionId: string,
    serverSessionId: string,
  ): Promise<void> {
    const prompts = await extractUserPrompts(claudeSessionId, 20);
    for (const entry of prompts) {
      // 1) Cross-attach dedup via transcript line index
      const dedupKey = `${claudeSessionId}:${entry.index}`;
      if (this.sentPromptKeys.has(dedupKey)) continue;
      this.sentPromptKeys.add(dedupKey);

      // 2) Skip phone-originated commands (session-scoped, one-shot, 10-min window)
      if (this.consumePhoneCommandMatch(serverSessionId, entry.text)) continue;

      const prompt = entry.text.slice(0, MAX_PROMPT_LENGTH);
      const relayMsg: SessionEventMessage = {
        type: 'event',
        payload: {
          clientEventId: `prompt:${claudeSessionId}:${entry.index}`,
          sessionId: serverSessionId,
          agent: 'claude-code-hook',
          eventType: 'user_prompt',
          data: {
            type: 'user_prompt',
            prompt,
            summary: entry.text.slice(0, 200),
            timestamp: entry.timestamp,
            index: entry.index,
          },
          ts: entry.timestamp,
        },
      };
      this.relay.sendEvent(serverSessionId, relayMsg);
    }
  }

  /** Backfill assistant messages from CC transcript so phone shows conversation history. */
  private async _backfillAssistantHistory(claudeSessionId: string, serverSessionId: string): Promise<void> {
    try {
      const { loadConversation } = await import('./claude-transcripts.js');
      const entries = loadConversation(claudeSessionId, 5);
      if (entries.length === 0) return;

      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i];
        if (entry.role !== 'assistant') continue;
        this.relay.sendRaw(JSON.stringify({
          type: 'event',
          payload: {
            clientEventId: `hist:${claudeSessionId}:${entry.index || i}`,
            sessionId: serverSessionId,
            agent: 'claude-code-hook',
            eventType: 'task_complete',
            data: {
              type: 'task_complete',
              summary: entry.text.slice(0, 200),
              output: entry.text.slice(0, 500),
            },
            ts: entry.timestamp || new Date().toISOString(),
          },
        }));
      }
    } catch { /* best-effort */ }
  }

  // ── Phone command dedup methods ──────────────────────────

  /** Record a claimed phone command fingerprint (called after /v1/pending-commands/claim succeeds). */
  recordClaimedPhoneCommand(serverSessionId: string, text: string): void {
    const fp = this.fingerprintText(text);
    if (!fp) return;
    const now = Date.now();
    const entries = this.prunePhoneCommandFingerprints(serverSessionId, now);
    entries.push({ fingerprint: fp, recordedAt: now });
    while (entries.length > ApprovalBridge.MAX_PHONE_COMMANDS_PER_SESSION) entries.shift();
    this.recentPhoneCommandsBySession.set(serverSessionId, entries);
    // Increment pending delivery counter for task_complete synthesis
    const count = this.pendingPhoneDeliveryCount.get(serverSessionId) ?? 0;
    this.pendingPhoneDeliveryCount.set(serverSessionId, count + 1);
  }

  /** Check and consume one matching fingerprint (one-shot). */
  private consumePhoneCommandMatch(serverSessionId: string, text: string, now = Date.now()): boolean {
    const fp = this.fingerprintText(text);
    const entries = this.prunePhoneCommandFingerprints(serverSessionId, now);
    const idx = entries.findIndex((e) => e.fingerprint === fp);
    if (idx === -1) return false;
    entries.splice(idx, 1);
    return true;
  }

  /** Remove expired entries and prune empty session keys. */
  private prunePhoneCommandFingerprints(serverSessionId: string, now: number): PhoneCommandFingerprint[] {
    const entries = this.recentPhoneCommandsBySession.get(serverSessionId) ?? [];
    const valid = entries.filter((e) => now - e.recordedAt < ApprovalBridge.PHONE_COMMAND_DEDUP_MS);
    if (valid.length > 0) {
      this.recentPhoneCommandsBySession.set(serverSessionId, valid);
    } else {
      this.recentPhoneCommandsBySession.delete(serverSessionId);
    }
    return valid;
  }

  private fingerprintText(text: string): string {
    return text.trim().toLowerCase().slice(0, 200);
  }

  getSessionCount(): number {
    return this.sessions.size;
  }

  /** Attach a Claude Code session by sessionId. Resolves local transcript first;
   *  throws if no transcript found. Registers with relay using source='transcript_attach'.
   *  After registration, replays recent user prompts as user_prompt events (best-effort). */
  async attachClaudeSession(claudeSessionId: string): Promise<string> {
    const transcript = await resolveClaudeTranscript(claudeSessionId).catch(() => null);
    if (!transcript) {
      throw new Error(`No local transcript found for session ${claudeSessionId}`);
    }
    this.transcriptAttachedIds.add(claudeSessionId);
    const existingServerSessionId = this.sessions.get(claudeSessionId);
    const serverSessionId = existingServerSessionId
      ?? await this.ensureSession(claudeSessionId, undefined, 'transcript_attach');
    if (existingServerSessionId) {
      this.relay.sendRaw(JSON.stringify({
        type: 'attach_session',
        payload: {
          sessionId: existingServerSessionId,
          claudeSessionId,
          metadata: {
            claudeSessionId,
            runtime: 'claude-code',
            source: 'transcript_attach',
            // Do NOT send title here — the relay already has the correct
            // tab-synced title. Sending transcript.title ("你好" etc.) would
            // overwrite it via the metadata merge.
            cwd: transcript.cwd || '',
            attachedAt: new Date().toISOString(),
          },
        },
      }));
    }
    // Replay recent conversation history to relay (so phone sees same as sidebar)
    this.replayUserPrompts(claudeSessionId, serverSessionId).catch(() => {});
    this._backfillAssistantHistory(claudeSessionId, serverSessionId).catch(() => {});
    return serverSessionId;
  }

  /** Detach a previously-attached Claude session by claudeSessionId.
   *  Sends deactivate_session to relay. Local caches are cleared when
   *  session_deactivated arrives back via WS (handled by constructor listener).
   *  Returns immediately — eventual consistency via sidebar polling. */
  async detachClaudeSession(claudeSessionId: string): Promise<{ ok: boolean }> {
    if (!claudeSessionId) return { ok: false };
    const serverSessionId = this.sessions.get(claudeSessionId);
    if (!serverSessionId) return { ok: true };

    this.relay.sendRaw(JSON.stringify({
      type: 'deactivate_session',
      payload: { sessionId: serverSessionId },
    }));

    // Return immediately — constructor listener + sidebar polling handle cleanup
    return { ok: true };
  }

  /** Send prune_sessions to relay to clean up finished transcript-attached sessions
   *  that are no longer in the sidebar's keep list. Safe to call periodically —
   *  no-op if the keep list is empty. */
  pruneSessions(): void {
    const keepClaudeSessionIds = Array.from(this.transcriptAttachedIds);
    if (keepClaudeSessionIds.length === 0) return;
    this.relay.sendRaw(JSON.stringify({
      type: 'prune_sessions',
      payload: { keepClaudeSessionIds },
    }));
  }

  /** Return registered windows with lastSeen timestamps (for /v1/shutdown TTL guard). */
  getActiveWindows(): Map<string, number> {
    return new Map(this.activeWindows);
  }

  /** Return the set of sessionIds that are currently attached (known to the bridge).
   *  Includes both CC transcript-attached sessions and Codex resumed sessions. */
  getAttachedSessionIds(): string[] {
    const cc = Array.from(this.transcriptAttachedIds).filter((csid) => this.sessions.has(csid));
    const codex = Array.from(this._codexAttachedIds);
    return [...cc, ...codex];
  }

  /** Return all claudeSessionIds currently tracked as active (have fired hook events). */
  getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** On bridge startup (or reconnection), reconcile attached sessions from relay to survive restarts.
   *  Sends WS query_attached_sessions and waits for attached_sessions response.
   *  Replaces ALL previously transcript-attached sessions with the relay's active set. */
  async reconcileAttachedSessions(): Promise<void> {
    if (!this.relay) return;

    // Capture pre-reconciliation set so we can re-register sessions
    // the relay may have finished during a WS disconnect (cleanup timer).
    const prevAttached = new Set(this.transcriptAttachedIds);
    let responded = false;

    return new Promise<void>((resolve) => {
      const handler = (payload: unknown) => {
        responded = true;
        const p = payload as { sessions: { id: string; claudeSessionId: string | null }[] };

        // Build the new set of claudeSessionIds from relay
        const newAttached = new Set<string>();
        const newEntries = new Map<string, string>();
        const codexLocalIds = this.knownCodexLocalSessionIds();
        for (const s of p.sessions) {
          if (s.claudeSessionId && !codexLocalIds.has(s.claudeSessionId)) {
            newAttached.add(s.claudeSessionId);
            newEntries.set(s.claudeSessionId, s.id);
          }
        }

        // Remove stale transcript-attached sessions no longer active on relay
        for (const csid of this.transcriptAttachedIds) {
          if (!newAttached.has(csid)) {
            const ssid = this.sessions.get(csid);
            this.sessions.delete(csid);
            if (this.primarySessionId === ssid) this.primarySessionId = null;
          }
        }

        // Add/renew transcript-attached sessions from relay
        for (const [csid, ssid] of newEntries) {
          this.sessions.set(csid, ssid);
          if (!this.primarySessionId) this.primarySessionId = ssid;
        }

        // Replace transcriptAttachedIds with the relay's view
        this.transcriptAttachedIds = newAttached;

        resolve();

        // Re-register any previously-attached sessions that the relay lost
        // (e.g. finished during WS disconnect cleanup). This is a best-effort
        // recovery so the mini program can see and interact with these sessions.
        for (const csid of prevAttached) {
          if (!newAttached.has(csid)) {
            console.error('[bridge] reconcile: re-registering lost session %s', csid);
            this.ensureSession(csid, undefined, 'transcript_attach').catch((err) => {
              console.error('[bridge] reconcile: re-register failed for %s: %s', csid, err);
            });
          }
        }
      };

      this.relay.once('attached_sessions', handler);
      this.relay.sendRaw(JSON.stringify({ type: 'query_attached_sessions' }));

      // Timeout: if the relay never responded, re-register to be safe
      setTimeout(() => {
        if (!responded) {
          this.relay.off('attached_sessions', handler);
          for (const csid of prevAttached) {
            console.error('[bridge] reconcile: timeout, re-registering session %s', csid);
            this.ensureSession(csid, undefined, 'transcript_attach').catch((err) => {
              console.error('[bridge] reconcile: re-register failed for %s: %s', csid, err);
            });
          }
        }
        resolve();
      }, 5_000);
    }).catch(() => {});
  }
}
