import { randomUUID } from 'node:crypto';
import { RelayClient } from '../daemon/relay-client.js';
import { CommandQueue } from './command-queue.js';
import type { AgentEventPayload, SessionEventMessage } from '@codekey/shared';

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

export class ApprovalBridge {
  readonly commandQueue = new CommandQueue();
  private sessions = new Map<string, string>(); // claudeSessionId → serverSessionId
  private inFlightSessions = new Map<string, Promise<string>>(); // claudeSessionId → registering promise
  private registeredClientRequests = new Map<string, (sid: string) => void>(); // clientRequestId → resolve
  private pendingByServerEventId = new Map<string, PendingApproval>();
  private primarySessionId: string | null = null;
  private windowLabels = new Map<string, string>(); // windowId → session label (tab title)
  private activeWindows = new Map<string, number>(); // windowId → lastSeen timestamp

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

    // Migrate pendingByServerEventId key from clientEventId → serverEventId
    this.relay.on('event_ack', (payload: unknown) => {
      const ack = payload as { clientEventId?: string | null; serverEventId: string };
      if (ack.clientEventId) {
        const entry = this.pendingByServerEventId.get(ack.clientEventId);
        if (entry) {
          this.pendingByServerEventId.delete(ack.clientEventId);
          this.pendingByServerEventId.set(ack.serverEventId, entry);
        }
      }
    });

    // Resolve pending approval from phone decision (keyed by serverEventId)
    this.relay.on('approval_forward', (payload: unknown) => {
      const fwd = payload as { eventId: string; decision: string };
      const entry = this.pendingByServerEventId.get(fwd.eventId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pendingByServerEventId.delete(fwd.eventId);
        entry.resolve({ approved: fwd.decision === 'approve' });
      }
    });
  }

  /** Register a VSCode window so its hook events can be associated with this windowId. */
  registerWindow(windowId: string): void {
    if (windowId) this.activeWindows.set(windowId, Date.now());
  }

  /** Set a label that will be applied to sessions from the given window. */
  setPendingLabel(windowId: string, label: string): void {
    if (windowId && label) this.windowLabels.set(windowId, label);
  }

  /** Get the most recently registered active windowId, or undefined. */
  private _getActiveWindowId(): string | undefined {
    let best: string | undefined;
    let bestTs = 0;
    for (const [wid, ts] of this.activeWindows) {
      if (ts > bestTs) { best = wid; bestTs = ts; }
    }
    return best;
  }

  /** Ensure a server session exists for the given claudeSessionId. */
  async ensureSession(claudeSessionId: string, windowId?: string): Promise<string> {
    if (!claudeSessionId) {
      throw new Error('ensureSession requires non-empty claudeSessionId');
    }

    // Fast path: already registered
    const existing = this.sessions.get(claudeSessionId);
    if (existing) return existing;

    // Deduplicate concurrent registrations for the same claudeSessionId
    const inFlight = this.inFlightSessions.get(claudeSessionId);
    if (inFlight) return inFlight;

    const promise = this._registerOnRelay(claudeSessionId, windowId).then((serverSessionId) => {
      this.sessions.set(claudeSessionId, serverSessionId);
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

  private _registerOnRelay(claudeSessionId: string, windowId?: string): Promise<string> {
    const clientRequestId = randomUUID();
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.registeredClientRequests.delete(clientRequestId);
        reject(new Error('Session registration timeout'));
      }, 10_000);
      this.registeredClientRequests.set(clientRequestId, (sid: string) => {
        clearTimeout(timer);
        resolve(sid);
      });
      const payload: Record<string, string> = {
        agentType: 'claude-code-hook',
        claudeSessionId,
        clientRequestId,
      };
      if (windowId) {
        payload.windowId = windowId;
        const label = this.windowLabels.get(windowId);
        if (label) payload.sessionLabel = label;
      }
      this.relay.sendRaw(JSON.stringify({
        type: 'register_session',
        payload,
      }));
    });
  }

  /** Forward a PermissionRequest hook event to relay. */
  async handleApproval(body: unknown): Promise<{ approved: boolean }> {
    const payload = body as { claudeSessionId?: string; codekeyWindowId?: string; rawEvent?: { tool_input?: { command?: string; cwd?: string } } };
    const claudeSessionId = payload.claudeSessionId ?? '';
    if (!claudeSessionId) return { approved: false };

    // Determine windowId: from hook request body, or fall back to most recent active window
    const windowId = payload.codekeyWindowId || this._getActiveWindowId() || '';

    console.error('[bridge] handleApproval: session=%s, codekeyWindowId=%s, fallback=%s, resolved=%s',
      claudeSessionId, payload.codekeyWindowId || '(none)', this._getActiveWindowId() || '(none)', windowId || '(none)');

    let serverSessionId: string;
    try {
      serverSessionId = await this.ensureSession(claudeSessionId, windowId);
    } catch {
      return { approved: false };
    }

    const input = payload.rawEvent?.tool_input ?? {};
    const command = input.command ?? '';
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
          action: 'run_command',
          command,
          risk: 'medium',
          summary: command.slice(0, 200),
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
      const timer = setTimeout(() => {
        this.pendingByServerEventId.delete(clientEventId);
        resolve({ approved: false });
      }, 120_000);
      this.pendingByServerEventId.set(clientEventId, { resolve, timer });
    });
  }

  /** Forward non-approval hook event (task_complete, session_idle) to relay. */
  async handleHookEvent(body: HookEventBody): Promise<void> {
    const claudeSessionId = body.claudeSessionId ?? '';
    if (!claudeSessionId) return;

    // Determine windowId: from hook request body, or fall back to most recent active window
    const windowId = body.codekeyWindowId || this._getActiveWindowId() || '';

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

    // task_complete means the Claude Code session has ended.
    // Clear the local cache so the next hook call triggers a fresh
    // register_session and creates a new server-side session.
    if (body.eventType === 'task_complete') {
      this.sessions.delete(claudeSessionId);
    }
  }

  listenRelayCommands(): void {
    this.relay.on('command', (payload: { sessionId?: string; action: string; data: string }) => {
      if (payload.action !== 'write_stdin') return;
      if (!payload.sessionId || payload.sessionId !== this.primarySessionId) return;
      this.commandQueue.push({
        id: randomUUID(),
        sessionId: payload.sessionId,
        text: payload.data,
        source: 'relay:command',
        timestamp: new Date().toISOString(),
      });
    });
  }

  getSessionCount(): number {
    return this.sessions.size;
  }
}
