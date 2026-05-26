import { randomUUID } from 'node:crypto';
import { RelayClient } from '../daemon/relay-client.js';
import { CommandQueue } from './command-queue.js';
import type { AgentEventPayload, SessionEventMessage } from '@codekey/shared';

export interface HookEventBody {
  eventType: 'task_complete' | 'session_idle';
  claudeSessionId?: string;
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
  private registeredClientRequests = new Map<string, (sid: string) => void>(); // clientRequestId → resolve
  private pendingByServerEventId = new Map<string, PendingApproval>();
  private primarySessionId: string | null = null;

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

  /** Ensure a server session exists for the given claudeSessionId. */
  async ensureSession(claudeSessionId: string): Promise<string> {
    if (!claudeSessionId) {
      throw new Error('ensureSession requires non-empty claudeSessionId');
    }

    const existing = this.sessions.get(claudeSessionId);
    if (existing) return existing;

    const serverSessionId = await this._registerOnRelay(claudeSessionId);
    this.sessions.set(claudeSessionId, serverSessionId);
    if (!this.primarySessionId) this.primarySessionId = serverSessionId;
    return serverSessionId;
  }

  private _registerOnRelay(claudeSessionId: string): Promise<string> {
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
      this.relay.sendRaw(JSON.stringify({
        type: 'register_session',
        payload: { agentType: 'claude-code-hook', claudeSessionId, clientRequestId },
      }));
    });
  }

  /** Forward a PermissionRequest hook event to relay. */
  async handleApproval(body: unknown): Promise<{ approved: boolean }> {
    const payload = body as { claudeSessionId?: string; rawEvent?: { tool_input?: { command?: string; cwd?: string } } };
    const claudeSessionId = payload.claudeSessionId ?? '';
    if (!claudeSessionId) return { approved: false };

    let serverSessionId: string;
    try {
      serverSessionId = await this.ensureSession(claudeSessionId);
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

    let serverSessionId: string;
    try {
      serverSessionId = await this.ensureSession(claudeSessionId);
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

    this.relay.sendEvent(serverSessionId, relayMsg);
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
