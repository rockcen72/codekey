import type { RelayClient } from './relay-client.js';

/**
 * Codex approval relay. Lives in the bridge process.
 *
 * Approvals: registerApproval → session + approval_required → relay → mini program.
 * Decisions come back via approval_forward → cached → extension polls → respondApproval.
 *
 * Remote input: Mini program sends command → relay → CodexRelay queues → extension
 * polls → client.startTurn(). Replies go back via pushEvent → relay → mini program.
 */
export class CodexRelay {
  private pendingQueue: { correlationId: string; command: string; risk: string }[] = [];
  private decisions: { correlationId: string; decision: string }[] = [];
  private prompts: string[] = [];
  private sessionId: string | null = null;
  private sessionPending = false;
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

  /** Register the Codex session with relay (called after thread/start). */
  ensureSession(): void {
    if (this.sessionPending) return;
    this._registerSession();
  }

  /**
   * Push a generic event to the relay under this Codex session.
   * Used for sending task_complete, status updates, etc. back to the mini program.
   */
  pushEvent(eventType: string, data: Record<string, unknown>): void {
    if (!this.sessionId) return;
    this.relay.sendRaw(JSON.stringify({
      type: 'event',
      payload: {
        sessionId: this.sessionId,
        eventType,
        data,
      },
    }));
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
      // Register the command listener now that we have a real sessionId
      // (re-register is harmless — the old listener already checks sessionId)
      for (const a of this.pendingQueue) this._pushApproval(a.correlationId, a.command, a.risk);
      this.pendingQueue = [];
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
}
