import type { RelayClient } from './relay-client.js';
import { runPrivacyPipeline, toCheckedPayload, ensureSafeSummary } from './privacy-pipeline.js';
import type { AuditSink } from './privacy-pipeline.js';

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
  private _auditSink?: AuditSink;

  /**
   * @param relay RelayClient
   * @param auditSink Optional audit sink
   * @param resolveCommandData Optional callback to resolve sealed_command to plaintext.
   *                          Pass ApprovalBridge.resolveCommandData when available.
   */
  constructor(
    relay: RelayClient,
    auditSink?: AuditSink,
    private resolveCommandData?: (payload: {
      data?: string;
      sealed_command?: string;
      command_id?: string;
      key_id?: string;
      encryption_version?: number;
      sessionId?: string;
    }) => string | null,
  ) {
    this.relay = relay;
    this._auditSink = auditSink;

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
      const cmd = payload as {
        sessionId: string;
        action: string;
        data?: string;
        sealed_command?: string;
        command_id?: string;
        key_id?: string;
        encryption_version?: number;
      };
      if (cmd.sessionId !== this.sessionId || cmd.action !== 'write_stdin') return;

      // Phase 4B: resolve sealed_command via callback or fall back to plain data
      let text: string | null = null;
      if (this.resolveCommandData) {
        text = this.resolveCommandData(cmd);
      } else {
        text = cmd.data ?? null;
      }

      if (text) {
        this.prompts.push(text);
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
    const rawPayload = ensureSafeSummary(JSON.stringify({
      type: 'event',
      payload: {
        sessionId: this.sessionId,
        eventType: 'approval_required',
        data: { command, summary: command.slice(0, 200), risk, toolName: 'Codex' },
        risk,
        clientEventId: correlationId,
      },
    }));
    const decision = runPrivacyPipeline({ source: 'approval', rawPayload }, undefined, this._auditSink);
    if (decision.action === 'block') return;
    this.pendingByCorrelationId.set(correlationId, { type: 'approval', command, risk, createdAt: Date.now() });
    const checked = toCheckedPayload(decision);
    if (checked) this.relay.sendCheckedPayload(checked);
  }

  private _sendEvent(eventType: string, data: Record<string, unknown>): void {
    if (!this.sessionId) return;
    const requestId = eventType === 'input_required' && typeof data.requestId === 'string'
      ? data.requestId
      : undefined;
    const source: 'approval' | 'transcript' = eventType === 'input_required' ? 'approval' : 'transcript';
    const rawPayload = ensureSafeSummary(JSON.stringify({
      type: 'event',
      payload: { sessionId: this.sessionId, eventType, data, ...(requestId ? { clientEventId: requestId } : {}) },
    }));
    const decision = runPrivacyPipeline({ source, rawPayload }, undefined, this._auditSink);
    if (decision.action === 'block') return;
    if (eventType === 'input_required' && requestId) {
      const text = typeof data.body === 'string' ? data.body.slice(0, 200) : '';
      this.pendingByCorrelationId.set(requestId, { type: 'input', command: text, risk: 'medium', createdAt: Date.now() });
    }
    const checked = toCheckedPayload(decision);
    if (checked) this.relay.sendCheckedPayload(checked);
  }
}
