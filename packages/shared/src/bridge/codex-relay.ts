import type { RelayClient } from './relay-client.js';

export class CodexRelay {
  private pendingQueue: { correlationId: string; command: string; risk: string }[] = [];
  private decisions: { correlationId: string; decision: string }[] = [];
  private prompts: string[] = [];
  /** Buffered events pushed before session_registered. */
  private pendingEvents: { eventType: string; data: Record<string, unknown> }[] = [];
  private sessionId: string | null = null;
  private sessionPending = false;
  /** Resolved when session_registered arrives. */
  private sessionReadyResolve: (() => void) | null = null;
  private sessionReadyPromise: Promise<void> | null = null;
  private codexSessionUid: string | null = null;
  private relay: RelayClient;

  constructor(relay: RelayClient) {
    this.relay = relay;

    relay.on('approval_forward', (payload: unknown) => {
      const fwd = payload as { eventId: string; decision: string; clientEventId?: string | null };
      let correlationId: string | null = null;
      if (fwd.clientEventId && fwd.clientEventId !== fwd.eventId) {
        correlationId = fwd.clientEventId;
      } else {
        correlationId = fwd.eventId;
      }
      if (correlationId) {
        this.decisions.push({ correlationId, decision: fwd.decision });
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
  ensureSession(): Promise<void> {
    if (this.sessionId) return Promise.resolve();
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

  pollDecisions(): { correlationId: string; decision: string }[] {
    const r = this.decisions.slice();
    this.decisions = [];
    return r;
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
        metadata: { title: 'Codex Session', source: 'managed_codex_relay' },
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
    this.relay.sendRaw(JSON.stringify({
      type: 'event',
      payload: { sessionId: this.sessionId, eventType, data },
    }));
  }
}
