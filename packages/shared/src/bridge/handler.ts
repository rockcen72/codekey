import { randomUUID } from 'node:crypto';
import { RelayClient } from './relay-client.js';
import { CommandQueue } from './command-queue.js';
import {
  resolveClaudeTranscript,
  extractUserPrompts,
} from './claude-transcripts.js';
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
}

interface ApprovalHookBody {
  claudeSessionId?: string;
  codekeyWindowId?: string;
  rawEvent?: Record<string, unknown>;
}

interface ApprovalText {
  toolName: string;
  command: string;
  summary: string;
}

export class ApprovalBridge {
  readonly commandQueue = new CommandQueue();
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

  // ── Phone command dedup ─────────────────────────────────────
  private static readonly PHONE_COMMAND_DEDUP_MS = 10 * 60 * 1000;
  private static readonly MAX_PHONE_COMMANDS_PER_SESSION = 50;

  private recentPhoneCommandsBySession = new Map<string, PhoneCommandFingerprint[]>();

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

      // Remove from sessions map by serverSessionId
      for (const [csid, ssid] of this.sessions) {
        if (ssid === p.sessionId) {
          this.sessions.delete(csid);
          if (this.primarySessionId === ssid) {
            this.primarySessionId = null;
          }
          break;
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

      // Also clean up transcriptAttachedIds for any matching claudeSessionId
      for (const csid of this.transcriptAttachedIds) {
        if (this.sessions.get(csid) === p.sessionId) {
          this.transcriptAttachedIds.delete(csid);
          break;
        }
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
      const payload: Record<string, unknown> = {
        agentType: 'claude-code-hook',
        claudeSessionId,
        clientRequestId,
        metadata: {
          claudeSessionId,
          runtime: 'claude-code',
          source: source || 'hook',
          title: transcript?.title || '',
          cwd: transcript?.cwd || '',
          lastHookAt: new Date().toISOString(),
        },
      };
      if (windowId) {
        payload.windowId = windowId;
        const label = this.windowLabels.get(windowId);
        if (label) {
          payload.sessionLabel = label;
          // Override transcript-derived title with synced tab label.
          // Required: server merges payload.metadata AFTER sessionLabel,
          // so without this override, the transcript title would win.
          if (payload.metadata) {
            (payload.metadata as Record<string, unknown>).title = label;
          }
        }
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
    const claudeSessionId = payload.claudeSessionId ?? '';
    if (!claudeSessionId) return { approved: false };

    // Determine windowId: from hook request body, or fall back to most recent active window
    const windowId = payload.codekeyWindowId || this._getActiveWindowId() || '';
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

    return {
      toolName,
      command,
      summary: command.slice(0, 200),
    };
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

    // Replay latest prompts BEFORE sending approval — guarantees ordering
    await this.replayUserPrompts(claudeSessionId, serverSessionId).catch(() => {});

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
          command: approvalText.command,
          risk: 'medium',
          summary: approvalText.summary,
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

    return new Promise<{ approved: boolean }>((resolve) => {
      const entry: PendingApproval = { resolve, timer: null as any };
      entry.timer = setTimeout(() => {
        // Clean up ALL keys (clientEventId + serverEventId fallback)
        for (const [key, val] of this.pendingByServerEventId) {
          if (val === entry) this.pendingByServerEventId.delete(key);
        }
        resolve({ approved: false });
      }, 120_000);
      this.pendingByServerEventId.set(clientEventId, entry);
    });
  }

  /** Forward non-approval hook event (task_complete, session_idle) to relay. */
  async handleHookEvent(body: HookEventBody): Promise<void> {
    const claudeSessionId = body.claudeSessionId ?? '';
    if (!claudeSessionId) return;

    const explicitWindowId = body.codekeyWindowId || '';
    const hasKnownSession = this.sessions.has(claudeSessionId) || this.inFlightSessions.has(claudeSessionId);
    if (!explicitWindowId && !hasKnownSession) {
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

    // Note: task_complete does NOT clean up local caches — session lifecycle
    // is managed by activateSession / deactivateSession (VSCode tab close).
  }

  listenRelayCommands(): void {
    this.relay.on('command', (payload: { sessionId?: string; action: string; data: string }) => {
      if (payload.action !== 'write_stdin') return;
      if (!payload.sessionId) return;
      // Normalized text is recorded via recordClaimedPhoneCommand at claim time, not here.
      // This method only queues the command for the relay-based command pipeline.
      this.commandQueue.push({
        id: randomUUID(),
        sessionId: payload.sessionId,
        text: payload.data,
        source: 'relay:command',
        timestamp: new Date().toISOString(),
      });
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
    const serverSessionId = await this.ensureSession(claudeSessionId, undefined, 'transcript_attach');
    // Replay recent user prompts as events (best-effort)
    await this.replayUserPrompts(claudeSessionId, serverSessionId).catch(() => {});
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

  /** Return the set of claudeSessionIds that are currently attached (known to the bridge). */
  getAttachedSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /** On bridge startup (or reconnection), reconcile attached sessions from relay to survive restarts.
   *  Sends WS query_attached_sessions and waits for attached_sessions response.
   *  Replaces ALL previously transcript-attached sessions with the relay's active set. */
  async reconcileAttachedSessions(): Promise<void> {
    if (!this.relay) return;

    return new Promise<void>((resolve) => {
      const handler = (payload: unknown) => {
        const p = payload as { sessions: { id: string; claudeSessionId: string | null }[] };

        // Build the new set of claudeSessionIds from relay
        const newAttached = new Set<string>();
        const newEntries = new Map<string, string>();
        for (const s of p.sessions) {
          if (s.claudeSessionId) {
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
      };

      this.relay.once('attached_sessions', handler);
      this.relay.sendRaw(JSON.stringify({ type: 'query_attached_sessions' }));

      // Timeout: don't block startup
      setTimeout(() => {
        this.relay.off('attached_sessions', handler);
        resolve();
      }, 5_000);
    }).catch(() => {});
  }
}
