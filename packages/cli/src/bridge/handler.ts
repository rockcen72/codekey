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
  serverSessionId: string | null = null;
  private pendingApprovals = new Map<string, PendingApproval>();

  constructor(readonly relay: RelayClient) {
    // Migrate pending entry from clientEventId → serverEventId on ack
    this.relay.on('event_ack', (payload: unknown) => {
      const ack = payload as { clientEventId?: string | null; serverEventId: string };
      if (ack.clientEventId) {
        const entry = this.pendingApprovals.get(ack.clientEventId);
        if (entry) {
          this.pendingApprovals.delete(ack.clientEventId);
          this.pendingApprovals.set(ack.serverEventId, entry);
        }
      }
    });

    // Resolve pending approval from phone decision (keyed by serverEventId)
    this.relay.on('approval_forward', (payload: unknown) => {
      const fwd = payload as { eventId: string; decision: string };
      const entry = this.pendingApprovals.get(fwd.eventId);
      if (entry) {
        clearTimeout(entry.timer);
        this.pendingApprovals.delete(fwd.eventId);
        entry.resolve({ approved: fwd.decision === 'approve' });
      }
    });
  }

  handleHookEvent(body: HookEventBody): void {
    if (!this.serverSessionId) {
      throw new Error('bridge session is not registered');
    }

    const data: AgentEventPayload = body.data.type === 'task_complete'
      ? { type: 'task_complete', summary: body.data.summary ?? '', summaryShort: body.data.summaryShort ?? '' }
      : { type: 'session_idle', idleMinutes: body.data.idleMinutes ?? 0 };

    const relayMsg: SessionEventMessage = {
      type: 'event',
      payload: {
        sessionId: this.serverSessionId,
        agent: 'claude-code-hook',
        eventType: body.eventType,
        data,
        ts: new Date().toISOString(),
      },
    };

    this.relay.sendEvent(this.serverSessionId, relayMsg);
  }

  /** Forward a PermissionRequest hook event to relay and wait for phone decision. */
  async handleApproval(body: unknown): Promise<{ approved: boolean }> {
    if (!this.serverSessionId) return { approved: false };

    const input = (body as { tool_name?: string; tool_input?: { command?: string; cwd?: string } })?.tool_input ?? {};
    const command = input.command ?? '';
    const clientEventId = randomUUID();

    const relayMsg: SessionEventMessage = {
      type: 'event',
      payload: {
        clientEventId,
        sessionId: this.serverSessionId,
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

    this.relay.sendEvent(this.serverSessionId, relayMsg);

    // Wait for phone decision (approval_forward) or timeout
    return new Promise<{ approved: boolean }>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingApprovals.delete(clientEventId);
        resolve({ approved: false });
      }, 120_000);
      this.pendingApprovals.set(clientEventId, { resolve, timer });
    });
  }

  listenRelayCommands(): void {
    this.relay.on('command', (payload: { sessionId?: string; action: string; data: string }) => {
      if (payload.action !== 'write_stdin') return;
      // Discard if session doesn't match the current bridge session
      if (payload.sessionId && payload.sessionId !== this.serverSessionId) {
        return;
      }
      this.commandQueue.push({
        id: randomUUID(),
        sessionId: payload.sessionId ?? this.serverSessionId ?? '',
        text: payload.data,
        source: 'relay:command',
        timestamp: new Date().toISOString(),
      });
    });
  }
}
