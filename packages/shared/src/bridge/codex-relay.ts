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
  private pendingByCorrelationId = new Map<string, { command: string; risk: string }>();
  private decisions: { correlationId: string; decision: string }[] = [];
  private sessionId: string | null = null;
  private relay: RelayClient;

  constructor(relay: RelayClient) {
    this.relay = relay;

    // Listen for approval_forward from mini program
    relay.on('approval_forward', (payload: unknown) => {
      const fwd = payload as { eventId: string; decision: string; clientEventId?: string | null };
      let entry = this.pendingByCorrelationId.get(fwd.eventId);
      if (!entry && fwd.clientEventId && fwd.clientEventId !== fwd.eventId) {
        entry = this.pendingByCorrelationId.get(fwd.clientEventId);
      }
      if (!entry) return;
      this.pendingByCorrelationId.delete(fwd.eventId);
      if (fwd.clientEventId && fwd.clientEventId !== fwd.eventId) {
        this.pendingByCorrelationId.delete(fwd.clientEventId);
      }
      this.decisions.push({ correlationId: fwd.eventId, decision: fwd.decision });
    });
  }

  /** Register a pending Codex approval and push to relay/mini program. */
  registerApproval(correlationId: string, command: string, risk: string): void {
    this.pendingByCorrelationId.set(correlationId, { command, risk });

    // Register a Codex session on first call (if not already)
    if (!this.sessionId) {
      const uid = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.relay.sendRaw(JSON.stringify({
        type: 'register_session',
        payload: {
          agentType: 'codex',
          claudeSessionId: uid,
          metadata: {
            title: `Codex Session`,
            source: 'managed_codex_relay',
          },
        },
      }));
      // The relay returns session_registered with the server session id.
      // Store a placeholder; it will be updated when session_registered arrives.
      this.sessionId = uid;

      // Listen for the session registration to get the real server session id
      const onRegistered = (payload: unknown) => {
        const p = payload as { claudeSessionId?: string; sessionId: string };
        if (p.claudeSessionId === uid && p.sessionId) {
          this.sessionId = p.sessionId;
        }
      };
      this.relay.on('session_registered', onRegistered);
    }

    // Push approval_required event to relay → mini program
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

  /** Get decisions from mini program. Called by extension polling. */
  pollDecisions(): { correlationId: string; decision: string }[] {
    const r = this.decisions.slice();
    this.decisions = [];
    return r;
  }
}
