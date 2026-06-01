import type { RelayClient } from './relay-client.js';

/**
 * Codex approval relay. Lives in the bridge process.
 *
 * Extension POSTs Codex approvals → this registers a session with the relay
 * and pushes approval_required events → mini program sees them.
 * Mini program decisions come back via approval_forward → this caches them.
 * Extension polls GET decisions → this returns and clears.
 */
export class CodexRelay {
  /** Pending approvals not yet sent (waiting for session registration). */
  private pendingQueue: { correlationId: string; command: string; risk: string }[] = [];
  /** Decisions returned from mini program, keyed by correlationId (clientEventId). */
  private decisions: { correlationId: string; decision: string }[] = [];
  /** Real server-side session id received from session_registered, or null before registration. */
  private sessionId: string | null = null;
  /** True once session registration has been sent. */
  private sessionPending = false;
  private relay: RelayClient;

  constructor(relay: RelayClient) {
    this.relay = relay;

    // Listen for approval_forward from mini program
    relay.on('approval_forward', (payload: unknown) => {
      const fwd = payload as { eventId: string; decision: string; clientEventId?: string | null };

      // The correlationId the extension used when POSTing the approval is stored as clientEventId.
      // approval_forward carries both eventId (server's event id) and clientEventId (our original key).
      // Always prefer clientEventId for lookup; fall back to eventId.
      let correlationId: string | null = null;

      if (fwd.clientEventId && fwd.clientEventId !== fwd.eventId) {
        // Matched by clientEventId → that IS the correlationId
        correlationId = fwd.clientEventId;
      } else {
        // No clientEventId or it equals eventId → try lookup by eventId
        correlationId = fwd.eventId;
      }

      if (correlationId) {
        this.decisions.push({ correlationId, decision: fwd.decision });
      }
    });
  }

  /** Register a pending Codex approval and push to relay/mini program. */
  registerApproval(correlationId: string, command: string, risk: string): void {
    if (this.sessionId) {
      // Session already registered → push immediately
      this._pushApproval(correlationId, command, risk);
    } else {
      // Session not yet registered → buffer and register
      this.pendingQueue.push({ correlationId, command, risk });
      if (!this.sessionPending) {
        this._registerSession();
      }
    }
  }

  /** Get decisions from mini program. Called by extension polling. */
  pollDecisions(): { correlationId: string; decision: string }[] {
    const r = this.decisions.slice();
    this.decisions = [];
    return r;
  }

  /** Register a Codex session with the relay. */
  private _registerSession(): void {
    this.sessionPending = true;
    const uid = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.relay.sendRaw(JSON.stringify({
      type: 'register_session',
      payload: {
        agentType: 'codex',
        claudeSessionId: uid,
        metadata: {
          title: 'Codex Session',
          source: 'managed_codex_relay',
        },
      },
    }));

    // Listen once for our session registration response
    const onRegistered = (payload: unknown) => {
      const p = payload as { claudeSessionId?: string; sessionId: string };
      if (p.claudeSessionId !== uid || !p.sessionId) return;
      // Store real server session id
      this.sessionId = p.sessionId;
      // Flush buffered approvals
      for (const a of this.pendingQueue) {
        this._pushApproval(a.correlationId, a.command, a.risk);
      }
      this.pendingQueue = [];
    };
    this.relay.on('session_registered', onRegistered);
  }

  /** Send an approval_required event to the relay (requires valid sessionId). */
  private _pushApproval(correlationId: string, command: string, risk: string): void {
    if (!this.sessionId) return;
    this.relay.sendRaw(JSON.stringify({
      type: 'event',
      payload: {
        sessionId: this.sessionId,
        eventType: 'approval_required',
        data: {
          command,
          summary: command.slice(0, 200),
          risk,
          toolName: 'Codex',
        },
        risk,
        clientEventId: correlationId,
      },
    }));
  }
}
