import type { RelayClient } from './relay-client.js';

export class CodexRelay {
  private pendingQueue: { correlationId: string; command: string; risk: string }[] = [];
  private decisions: { correlationId: string; decision: string; message?: string }[] = [];
  private prompts: string[] = [];
  /** Buffered events pushed before session_registered. */
  private pendingEvents: { eventType: string; data: Record<string, unknown> }[] = [];
  /** Pending approvals + inputs that have been sent to relay but not yet resolved.
   *  Exposed via getPendingApprovals() so the sidebar shows Codex cards. */
  private pendingByCorrelationId = new Map<string, {
    type: 'approval' | 'input';
    command: string;
    risk: string;
    createdAt: number;
  }>();
  /** @internal exposed read-only for /v1/pending-approvals merge. */
  _sessionId(): string | null { return this.sessionId; }
  /** @internal exposed read-only for /v1/pending-approvals merge. */
  _codexSessionUid(): string | null { return this.codexSessionUid; }

  private sessionId: string | null = null;
  private sessionPending = false;
  /** Resolved when session_registered arrives. */
  private sessionReadyResolve: (() => void) | null = null;
  private sessionReadyPromise: Promise<void> | null = null;
  private codexSessionUid: string | null = null;
  private sessionMetadata: Record<string, string> = {};
  private relay: RelayClient;

  constructor(relay: RelayClient) {
    this.relay = relay;

    relay.on('approval_forward', (payload: unknown) => {
      const fwd = payload as { eventId: string; decision: string; message?: string; clientEventId?: string | null };
      let correlationId: string | null = null;
      if (fwd.clientEventId && fwd.clientEventId !== fwd.eventId) {
        correlationId = fwd.clientEventId;
      } else {
        correlationId = fwd.eventId;
      }
      if (correlationId) {
        this.decisions.push({ correlationId, decision: fwd.decision, message: fwd.message });
        this.pendingByCorrelationId.delete(correlationId);
      }
    });

    relay.on('command', (payload: unknown) => {
      const cmd = payload as { sessionId: string; action: string; data: string };
      if (cmd.sessionId === this.sessionId && cmd.action === 'write_stdin' && cmd.data) {
        this.prompts.push(cmd.data);
      }
    });
  }

  /** Register session and wait until session_registered resolves. */
  ensureSession(metadata: Record<string, string> = {}): Promise<void> {
    if (this.sessionId) return Promise.resolve();
    this.sessionMetadata = { ...this.sessionMetadata, ...metadata };
    if (!this.sessionPending) this._registerSession();
    // Return a promise that resolves when session_registered fires
    return new Promise<void>((resolve) => {
      this.sessionReadyResolve = resolve;
    });
  }

  pushEvent(eventType: string, data: Record<string, unknown>): void {
    if (this.sessionId) {
      this._sendEvent(eventType, data);
    } else {
      this.pendingEvents.push({ eventType, data });
    }
  }

  registerApproval(correlationId: string, command: string, risk: string): void {
    if (this.sessionId) {
      this._pushApproval(correlationId, command, risk);
    } else {
      this.pendingQueue.push({ correlationId, command, risk });
      if (!this.sessionPending) this._registerSession();
    }
  }

  pollDecisions(): { correlationId: string; decision: string; message?: string }[] {
    const r = this.decisions.slice();
    this.decisions = [];
    return r;
  }

  /** Expose pending approvals/inputs that haven't received a decision yet.
   *  Used by /v1/pending-approvals so the sidebar includes Codex cards. */
  getPendingApprovals(): { id: string; command: string; risk: string; createdAt: number }[] {
    const out: { id: string; command: string; risk: string; createdAt: number }[] = [];
    const STALE_MS = 10 * 60 * 1000;
    for (const [id, entry] of this.pendingByCorrelationId) {
      if (Date.now() - entry.createdAt > STALE_MS) {
        this.pendingByCorrelationId.delete(id);
        continue;
      }
      out.push({ id, command: entry.command, risk: entry.risk, createdAt: entry.createdAt });
    }
    return out;
  }

  pollPrompts(): string[] {
    const r = this.prompts.slice();
    this.prompts = [];
    return r;
  }

  private _registerSession(): void {
    this.sessionPending = true;
    const uid = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.codexSessionUid = uid;

    this.relay.sendRaw(JSON.stringify({
      type: 'register_session',
      payload: {
        agentType: 'codex',
        claudeSessionId: uid,
        metadata: { title: 'Codex Session', source: 'managed_codex_relay', ...this.sessionMetadata },
      },
    }));

    const onRegistered = (payload: unknown) => {
      const p = payload as { claudeSessionId?: string; sessionId: string };
      if (p.claudeSessionId !== uid || !p.sessionId) return;
      this.sessionId = p.sessionId;

      // Flush buffered approvals
      for (const a of this.pendingQueue) this._pushApproval(a.correlationId, a.command, a.risk);
      this.pendingQueue = [];

      // Flush buffered events
      for (const e of this.pendingEvents) this._sendEvent(e.eventType, e.data);
      this.pendingEvents = [];

      // Resolve the ensureSession() promise
      if (this.sessionReadyResolve) {
        this.sessionReadyResolve();
        this.sessionReadyResolve = null;
      }
    };
    this.relay.on('session_registered', onRegistered);
  }

  private _pushApproval(correlationId: string, command: string, risk: string): void {
    if (!this.sessionId) return;
    this.pendingByCorrelationId.set(correlationId, { type: 'approval', command, risk, createdAt: Date.now() });
    this.relay.sendRaw(JSON.stringify({
      type: 'event',
      payload: {
        sessionId: this.sessionId,
        eventType: 'approval_required',
        data: { command, summary: command.slice(0, 200), risk, toolName: 'Codex' },
        risk,
        clientEventId: correlationId,
      },
    }));
  }

  private _sendEvent(eventType: string, data: Record<string, unknown>): void {
    if (!this.sessionId) return;
    const requestId = eventType === 'input_required' && typeof data.requestId === 'string'
      ? data.requestId
      : undefined;
    if (eventType === 'input_required' && requestId) {
      const text = typeof data.body === 'string' ? data.body.slice(0, 200) : '';
      this.pendingByCorrelationId.set(requestId, { type: 'input', command: text, risk: 'medium', createdAt: Date.now() });
    }
    this.relay.sendRaw(JSON.stringify({
      type: 'event',
      payload: { sessionId: this.sessionId, eventType, data, ...(requestId ? { clientEventId: requestId } : {}) },
    }));
  }
}
