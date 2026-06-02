import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { createEventStreamParser } from './sse-parser.js';
import { ApprovalBridge } from './handler.js';

/**
 * OpenCodeSessionManager manages the OpenCode integration via SSE + REST.
 *
 * API docs: https://opencode.ai/docs/server/
 * SDK types: https://github.com/sst/opencode/blob/dev/packages/sdk/js/src/gen/types.gen.ts
 *
 * SSE: GET /event
 * Permission reply: POST /session/:id/permissions/:permissionID { response }
 * Async prompt: POST /session/:id/prompt_async
 */
export class OpenCodeSessionManager {
  private bridge: ApprovalBridge;
  private opencodeBaseUrl: string;

  private opencodeSessions: Set<string> = new Set();
  private opencodeSessionToRelayId: Map<string, string> = new Map();
  private permissionMap: Map<string, { requestID: string; serverSessionId: string; localSessionID: string }> = new Map();
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
      const url = `${this.opencodeBaseUrl}/event`;
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
      case 'permission.updated':
        return this.onPermissionUpdated(event.properties);
      case 'permission.replied':
        return this.onPermissionReplied(event.properties);
      case 'session.created':
      case 'session.updated':
      case 'session.deleted':
        return this.onSessionEvent(event.type, event.properties);
      case 'session.idle':
        return this.onSessionIdle(event.properties);
      case 'session.error':
        return this.onSessionError(event.properties);
      case 'message.updated':
        return this.onMessageUpdated(event.properties);
      case 'message.part.updated':
        return this.onMessagePartUpdated(event.properties);
    }
  }

  // ── Permission handling ─────────────────────────────────

  /**
   * EventPermissionUpdated:
   *   properties IS the Permission object directly:
   *   { id, type, pattern?, sessionID, messageID, callID?, title, metadata, time }
   */
  private async onPermissionUpdated(props: Record<string, unknown>): Promise<void> {
    const requestID = props.id as string;
    const sessionID = props.sessionID as string;
    const permissionType = props.type as string;
    const title = props.title as string;
    const metadata = (props.metadata as Record<string, unknown>) ?? {};

    if (!requestID || !sessionID) return;

    const serverSessionId = await this.bridge.ensureSession(sessionID, undefined, 'opencode', {
      agentType: 'opencode',
      runtime: 'opencode',
    });
    this.opencodeSessions.add(serverSessionId);
    this.opencodeSessionToRelayId.set(sessionID, serverSessionId);

    const command = permissionToCommand(permissionType, metadata);
    const rawRisk = this.bridge.evaluateRisk(command);
    const risk = rawRisk === 'unknown' ? 'medium' : rawRisk;

    const clientEventId = `oc-perm:${requestID}`;

    this.bridge.sendEventToRelay(serverSessionId, {
      clientEventId,
      sessionId: serverSessionId,
      agent: 'opencode',
      eventType: 'approval_required',
      data: {
        type: 'approval_required',
        action: permissionType,
        command,
        risk,
        summary: title || `${permissionType}: ${command.slice(0, 200)}`,
      },
    });

    this.bridge.trackPendingApproval({
      id: clientEventId,
      claudeSessionId: sessionID,
      serverSessionId,
      agentType: 'opencode',
      command,
      summary: title || `${permissionType}: ${command.slice(0, 200)}`,
      toolName: permissionType,
      risk,
    });

    this.permissionMap.set(clientEventId, { requestID, serverSessionId, localSessionID: sessionID });
  }

  private onPermissionReplied(_props: Record<string, unknown>): void {
    // OpenCode already handled the reply locally.
    // Our pending will be resolved through approval_forward from the phone or local VS Code.
  }

  // ── Session lifecycle ───────────────────────────────────

  /**
   * EventSessionCreated/Updated/Deleted:
   *   properties: { info: Session }
   */
  private onSessionEvent(type: string, props: Record<string, unknown>): void {
    const info = props.info as Record<string, unknown> | undefined;
    if (!info) return;
    const sessionID = info.id as string;
    if (!sessionID) return;

    if (type === 'session.deleted') {
      const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
      if (serverSessionId) {
        this.opencodeSessions.delete(serverSessionId);
        this.opencodeSessionToRelayId.delete(sessionID);
      }
    }
  }

  /**
   * EventSessionIdle:
   *   properties: { sessionID: string }
   */
  private onSessionIdle(props: Record<string, unknown>): void {
    const sessionID = props.sessionID as string;
    if (!sessionID) return;
    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    this.bridge.sendEventToRelay(serverSessionId, {
      sessionId: serverSessionId,
      agent: 'opencode',
      eventType: 'task_complete',
      data: {
        type: 'task_complete',
        summary: 'Session idle',
      },
    });
  }

  /**
   * EventSessionError:
   *   properties: { sessionID?: string, error?: ... }
   */
  private onSessionError(props: Record<string, unknown>): void {
    const sessionID = props.sessionID as string;
    if (!sessionID) return;
    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    const errorObj = props.error as Record<string, unknown> | undefined;
    const message = (errorObj?.message as string) || 'Session error';

    this.bridge.sendEventToRelay(serverSessionId, {
      sessionId: serverSessionId,
      agent: 'opencode',
      eventType: 'error',
      data: {
        type: 'error',
        message,
      },
    });
  }

  // ── Message handling ────────────────────────────────────

  /**
   * EventMessageUpdated:
   *   properties: { info: Message }
   *   Message = UserMessage | AssistantMessage
   *   Both have: id, sessionID, role
   *   AssistantMessage has: cost, tokens, error?, finish?
   */
  private onMessageUpdated(props: Record<string, unknown>): void {
    const info = props.info as Record<string, unknown> | undefined;
    if (!info) return;
    const messageID = info.id as string;
    const sessionID = info.sessionID as string;
    if (!messageID || !sessionID) return;

    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    // Track message completion for status updates
    const key = `msg:${messageID}`;
    if (this.deliveredMessageParts.has(key)) return;
    this.deliveredMessageParts.add(key);

    if (this.deliveredMessageParts.size > 10000) {
      const arr = [...this.deliveredMessageParts];
      this.deliveredMessageParts = new Set(arr.slice(-5000));
    }

    // Check for errors in assistant messages
    const error = info.error as Record<string, unknown> | undefined;
    if (error) {
      this.bridge.sendEventToRelay(serverSessionId, {
        sessionId: serverSessionId,
        agent: 'opencode',
        eventType: 'error',
        data: {
          type: 'error',
          message: (error.message as string) || 'Unknown error',
        },
      });
    }
  }

  /**
   * EventMessagePartUpdated:
   *   properties: { part: Part, delta?: string }
   *   Part = TextPart | ToolPart | FilePart | ...
   *   TextPart: { id, sessionID, messageID, type: "text", text: string }
   *   ToolPart: { id, sessionID, messageID, type: "tool", state: ToolState }
   */
  private onMessagePartUpdated(props: Record<string, unknown>): void {
    const part = props.part as Record<string, unknown> | undefined;
    if (!part) return;

    const sessionID = part.sessionID as string;
    const messageID = part.messageID as string;
    const partID = part.id as string;
    const partType = part.type as string;
    if (!sessionID || !messageID) return;

    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    // Dedup by part ID
    const key = `part:${partID}`;
    if (this.deliveredMessageParts.has(key)) return;

    // Only forward text parts and completed tool parts
    if (partType === 'text') {
      this.deliveredMessageParts.add(key);
      const text = (part.text as string) || (props.delta as string) || '';
      if (!text) return;

      this.bridge.sendEventToRelay(serverSessionId, {
        sessionId: serverSessionId,
        agent: 'opencode',
        eventType: 'task_complete',
        data: {
          type: 'task_complete',
          summary: text.slice(0, 500),
        },
      });
    } else if (partType === 'tool') {
      const state = part.state as Record<string, unknown> | undefined;
      if (state?.status === 'completed') {
        this.deliveredMessageParts.add(key);
        const title = (state.title as string) || (part.tool as string) || 'Tool completed';
        this.bridge.sendEventToRelay(serverSessionId, {
          sessionId: serverSessionId,
          agent: 'opencode',
          eventType: 'task_complete',
          data: {
            type: 'task_complete',
            summary: title,
          },
        });
      }
    }
  }

  // ── Approval forwarding ─────────────────────────────────

  async handleApprovalForward(eventId: string, decision: string, clientEventId?: string): Promise<boolean> {
    const entry = this.permissionMap.get(eventId)
      ?? (clientEventId ? this.permissionMap.get(clientEventId) : undefined);
    if (!entry) return false;

    try {
      const response = decision === 'approve' ? 'once' : 'reject';
      const resp = await fetch(`${this.opencodeBaseUrl}/session/${entry.localSessionID}/permissions/${entry.requestID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ response }),
      });
      if (!resp.ok) throw new Error(`OpenCode reply returned ${resp.status}`);
    } catch (err) {
      this.bridge.sendErrorToRelay(entry.serverSessionId, `审批回写失败: ${err}`);
      return true;
    }

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
      const resp = await fetch(`${this.opencodeBaseUrl}/session/${opencodeSessionId}/prompt_async`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messageID: randomUUID(),
          parts: [{ type: 'text', text }],
        }),
      });
      if (!resp.ok) {
        throw new Error(`OpenCode prompt_async returned ${resp.status}`);
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

function permissionToCommand(permissionType: string, metadata: Record<string, unknown>): string {
  if (metadata.command) return metadata.command as string;
  if (metadata.filePath) return `${permissionType} ${metadata.filePath}`;
  if (metadata.patch) return `${permissionType} (patch: ${(metadata.patch as string).slice(0, 50)})`;
  return permissionType;
}
