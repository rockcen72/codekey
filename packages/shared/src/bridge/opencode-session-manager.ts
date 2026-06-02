import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { createEventStreamParser } from './sse-parser.js';
import { ApprovalBridge } from './handler.js';
import type { ApprovalResponder, CommandHandler } from './handler.js';

/**
 * OpenCodeSessionManager manages the OpenCode integration via SSE + REST.
 *
 * SSE event source: /api/events  (streams permission.asked, message.updated, etc.)
 * REST permission API: POST /permission/:requestID/reply
 * REST prompt API: POST /session/<id>/prompt
 */
export class OpenCodeSessionManager {
  private bridge: ApprovalBridge;
  private opencodeBaseUrl: string;

  // serverSessionId set (command routing via ownsSession)
  private opencodeSessions: Set<string> = new Set();

  // OpenCode local session ID → relay serverSessionId
  private opencodeSessionToRelayId: Map<string, string> = new Map();

  // clientEventId/eventId → { requestID, serverSessionId }
  private permissionMap: Map<string, { requestID: string; serverSessionId: string }> = new Map();

  // message.updated dedup
  private deliveredMessageParts: Set<string> = new Set();

  private _abortController: AbortController | null = null;
  private _stopped = false;

  constructor(opencodeBaseUrl: string, bridge: ApprovalBridge) {
    this.opencodeBaseUrl = opencodeBaseUrl;
    this.bridge = bridge;
  }

  ownsSession(serverSessionId: string): boolean {
    return this.opencodeSessions.has(serverSessionId);
  }

  /** Start SSE subscription. Does NOT await — call with .catch(). */
  async start(): Promise<void> {
    this.bridge.registerExternalApprovalResponder({
      agentType: 'opencode',
      onApprovalForward: (eventId, decision, clientEventId) =>
        this.handleApprovalForward(eventId, decision, clientEventId),
    });

    this.bridge.registerAgentCommandHandler({
      ownsSession: (sid) => this.opencodeSessions.has(sid),
      handleCommand: (payload) => this.handleCommand(payload.sessionId, payload.data),
    });

    // Migrate permissionMap keys on event_ack
    this.bridge.onEventAck((clientEventId, serverEventId) => {
      const entry = this.permissionMap.get(clientEventId);
      if (entry) {
        this.permissionMap.set(serverEventId, entry);
      }
    });

    this._abortController = new AbortController();
    this._stopped = false;
    await this.connectSSE();
  }

  stop(): void {
    this._stopped = true;
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this.opencodeSessions.clear();
    this.opencodeSessionToRelayId.clear();
    this.permissionMap.clear();
    this.deliveredMessageParts.clear();
  }

  // ── SSE connection ──────────────────────────────────────

  private connectSSE(): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = `${this.opencodeBaseUrl}/api/events`;
      const parts = new URL(url);

      const req = httpGet(
        {
          hostname: parts.hostname,
          port: parts.port,
          path: parts.pathname + parts.search,
          signal: this._abortController?.signal,
        },
        (res) => {
          if (!res.statusCode || res.statusCode >= 300) {
            reject(new Error(`SSE connection failed: ${res.statusCode}`));
            return;
          }
          resolve();

          const parser = createEventStreamParser();
          res.on('data', (chunk: Buffer) => {
            const events = parser.feed(chunk.toString('utf-8'));
            for (const evt of events) {
              this.handleSSEEvent(evt).catch((err) => {
                console.error('[opencode] SSE event handler error:', err);
              });
            }
          });
          res.on('error', (err) => {
            if (!this._stopped) {
              console.error('[opencode] SSE error:', err);
              // Reconnect after delay
              setTimeout(() => {
                if (!this._stopped) this.connectSSE().catch(() => {});
              }, 5000);
            }
          });
          res.on('end', () => {
            if (!this._stopped) {
              setTimeout(() => {
                if (!this._stopped) this.connectSSE().catch(() => {});
              }, 5000);
            }
          });
        },
      );

      req.on('error', (err) => {
        if (!this._stopped) {
          console.error('[opencode] SSE request error:', err);
          setTimeout(() => {
            if (!this._stopped) this.connectSSE().catch(() => {});
          }, 5000);
        }
        reject(err);
      });
    });
  }

  // ── Event dispatch ──────────────────────────────────────

  private async handleSSEEvent(event: { type: string; properties: Record<string, unknown> }): Promise<void> {
    switch (event.type) {
      case 'permission.asked':
        return this.onPermissionAsked(event.properties);
      case 'permission.replied':
        return this.onPermissionReplied(event.properties);
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
        return this.onSessionEvent(event.type, event.properties);
      case 'session.idle':
      case 'session.error':
        return this.forwardToRelay(event.type, event.properties);
      case 'message.updated':
        return this.onMessageUpdated(event.properties);
    }
  }

  // ── Session event handlers ──────────────────────────────

  private async onPermissionAsked(props: Record<string, unknown>): Promise<void> {
    const requestID = props.id as string;
    const sessionID = props.sessionID as string;
    const permission = props.permission as string;
    const metadata = (props.metadata as Record<string, unknown>) ?? {};

    // 1. Ensure session on relay
    const serverSessionId = await this.bridge.ensureSession(sessionID, undefined, 'opencode', {
      agentType: 'opencode',
      runtime: 'opencode',
    });
    this.opencodeSessions.add(serverSessionId);
    this.opencodeSessionToRelayId.set(sessionID, serverSessionId);

    // 2. Risk evaluation
    const command = permissionToCommand(permission, metadata);
    const risk = this.bridge.evaluateRisk(command);

    // 3. Fixed clientEventId
    const clientEventId = `oc-perm:${requestID}`;

    // 5. Send approval event to relay
    this.bridge.sendEventToRelay(serverSessionId, {
      clientEventId,
      sessionId: serverSessionId,
      agent: 'opencode',
      eventType: 'approval_required',
      data: {
        type: 'approval_required',
        action: permission,
        command,
        risk,
        summary: `${permission}: ${command.slice(0, 200)}`,
      },
    });

    // 6. Track pending
    this.bridge.trackPendingApproval({
      id: clientEventId,
      claudeSessionId: sessionID,
      serverSessionId,
      agentType: 'opencode',
      command,
      summary: `${permission}: ${command.slice(0, 200)}`,
      toolName: permission,
      risk: risk as 'low' | 'medium' | 'high' | 'critical',
    });

    // 7. Record mapping
    this.permissionMap.set(clientEventId, { requestID, serverSessionId });
  }

  private onPermissionReplied(_props: Record<string, unknown>): void {
    // OpenCode already handled the reply locally; our pending will be
    // resolved through approval_forward from the phone or local VS Code.
    // Nothing to do here.
  }

  private onSessionEvent(type: string, props: Record<string, unknown>): void {
    const sessionID = props.id as string;
    if (!sessionID) return;

    if (type === 'session.deleted') {
      const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
      if (serverSessionId) {
        this.opencodeSessions.delete(serverSessionId);
        this.opencodeSessionToRelayId.delete(sessionID);
      }
    } else if (type === 'session.created') {
      // Session will be registered when the first permission.asked arrives
    }
  }

  private forwardToRelay(type: string, props: Record<string, unknown>): void {
    const sessionID = props.id as string || props.sessionID as string;
    if (!sessionID) return;
    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    this.bridge.sendEventToRelay(serverSessionId, {
      sessionId: serverSessionId,
      agent: 'opencode',
      eventType: type === 'session.idle' ? 'task_complete' : 'error',
      data: {
        type: type === 'session.idle' ? 'task_complete' : 'error',
        summary: props.message as string || type,
      },
    });
  }

  private onMessageUpdated(properties: Record<string, unknown>): void {
    const messageID = properties.messageID as string;
    if (!messageID) return;

    const partIndex = (properties.partIndex as number) ?? 0;
    const key = `${messageID}:${partIndex}`;

    if (this.deliveredMessageParts.has(key)) return;
    this.deliveredMessageParts.add(key);

    if (this.deliveredMessageParts.size > 10000) {
      const arr = [...this.deliveredMessageParts];
      this.deliveredMessageParts = new Set(arr.slice(-5000));
    }

    // Extract sessionID from properties to find the relay session
    // Not all message.updated events carry sessionID; if missing, skip relay
    const sessionID = properties.sessionID as string || properties.session_id as string;
    if (!sessionID) return;

    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    this.bridge.sendEventToRelay(serverSessionId, {
      sessionId: serverSessionId,
      agent: 'opencode',
      eventType: 'task_complete',
      data: {
        type: 'task_complete',
        summary: (properties.content as string || properties.text as string || '').slice(0, 500),
      },
    });
  }

  // ── Approval forwarding ─────────────────────────────────

  async handleApprovalForward(eventId: string, decision: string, clientEventId?: string): Promise<boolean> {
    const entry = this.permissionMap.get(eventId)
      ?? (clientEventId ? this.permissionMap.get(clientEventId) : undefined);
    if (!entry) return false;

    // Step 1: POST reply to OpenCode first (fail = keep pending)
    try {
      const reply = decision === 'approve' ? 'once' : 'reject';
      const resp = await fetch(`${this.opencodeBaseUrl}/permission/${entry.requestID}/reply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply }),
      });
      if (!resp.ok) throw new Error(`OpenCode reply returned ${resp.status}`);
    } catch (err) {
      this.bridge.sendErrorToRelay(entry.serverSessionId, `审批回写失败: ${err}`);
      return true;
    }

    // Step 2: OpenCode accepted → resolve relay pending
    this.bridge.resolveEventOnRelay(eventId);
    if (clientEventId && clientEventId !== eventId) {
      this.bridge.resolveEventOnRelay(clientEventId);
    }
    this.permissionMap.delete(eventId);
    if (clientEventId) this.permissionMap.delete(clientEventId);

    return true;
  }

  // ── Command handling ────────────────────────────────────

  async handleCommand(sessionId: string, text: string): Promise<void> {
    const opencodeSessionId = this.resolveLocalSessionId(sessionId);
    if (!opencodeSessionId) return;

    try {
      const resp = await fetch(`${this.opencodeBaseUrl}/session/${opencodeSessionId}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text }],
        }),
      });
      if (!resp.ok) {
        throw new Error(`OpenCode prompt returned ${resp.status}`);
      }
    } catch (err) {
      this.bridge.sendErrorToRelay(sessionId, `命令发送失败: ${err}`);
    }
  }

  private resolveLocalSessionId(serverSessionId: string): string | null {
    for (const [local, server] of this.opencodeSessionToRelayId) {
      if (server === serverSessionId) return local;
    }
    return null;
  }
}

// ── Helpers ────────────────────────────────────────────────

function permissionToCommand(permission: string, metadata: Record<string, unknown>): string {
  if (metadata.command) return metadata.command as string;
  if (metadata.filePath) return `${permission} ${metadata.filePath}`;
  if (metadata.patch) return `${permission} (patch: ${(metadata.patch as string).slice(0, 50)})`;
  return permission;
}


