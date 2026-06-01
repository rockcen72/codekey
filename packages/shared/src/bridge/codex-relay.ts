import type { RelayClient } from './relay-client.js';

/**
 * Codex approval relay. Lives in the bridge process.
 *
 * Approvals: Extension POSTs → registers session + pushes approval_required →
 * relay → mini program sees it. Decisions come back via approval_forward →
 * cached and returned via extension polling → respondApproval().
 *
 * Remote input: Mini program sends command → relay → bridge →
 * CodexRelay queues it → extension polls → client.startTurn().
 */
export class CodexRelay {
  /** Pending approvals not yet sent (waiting for session registration). */
  private pendingQueue: { correlationId: string; command: string; risk: string }[] = [];
  /** Decisions returned from mini program, keyed by correlationId (clientEventId). */
  private decisions: { correlationId: string; decision: string }[] = [];
  /** Prompts from mini program, waiting for extension to send via startTurn. */
  private prompts: string[] = [];
  /** Real server-side session id received from session_registered, or null before registration. */
  private sessionId: string | null = null;
  /** True once session registration has been sent. */
  private sessionPending = false;
  /** The claudeSessionId (uid) we used to register with the relay. */
  private codexSessionUid: string | null = null;
  private relay: RelayClient;

  constructor(relay: RelayClient) {
    this.relay = relay;

    // ── approval_forward from mini program ─────────────
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

    // ── Remote prompt from mini program ────────────────
    relay.on('command', (payload: unknown) => {
      const cmd = payload as { sessionId: string; action: string; data: string };
      // Only intercept commands addressed to our Codex session
      if (cmd.sessionId === this.sessionId && cmd.action === 'write_stdin' && cmd.data) {
        this.prompts.push(cmd.data);
      }
    });
  }

  /** Register a pending Codex approval and push to relay/mini program. */
  registerApproval(correlationId: string, command: string, risk: string): void {
    if (this.sessionId) {
      this._pushApproval(correlationId, command, risk);
    } else {
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

  /** Get pending prompts from mini program. Called by extension polling. */
  pollPrompts(): string[] {
    const r = this.prompts.slice();
    this.prompts = [];
    return r;
  }

  /** Register a Codex session with the relay. */
  private _registerSession(): void {
    this.sessionPending = true;
    const uid = `codex-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.codexSessionUid = uid;

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

    const onRegistered = (payload: unknown) => {
      const p = payload as { claudeSessionId?: string; sessionId: string };
      if (p.claudeSessionId !== uid || !p.sessionId) return;
      this.sessionId = p.sessionId;
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
        data: { command, summary: command.slice(0, 200), risk, toolName: 'Codex' },
        risk,
        clientEventId: correlationId,
      },
    }));
  }
}
