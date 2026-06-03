import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { createEventStreamParser } from './sse-parser.js';
import { ApprovalBridge } from './handler.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

interface AttachedOpenCodeSession {
  localSessionId: string;
  serverSessionId?: string;
}

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const BACKOFF_MULTIPLIER = 2;

function getAttachedStoragePath(): string {
  const { tmpdir } = require('node:os');
  const { join } = require('node:path');
  return join(tmpdir(), 'codekey-opencode-attached.json');
}

function loadAttachedSessions(): AttachedOpenCodeSession[] {
  try {
    const path = getAttachedStoragePath();
    if (!existsSync(path)) return [];
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) => {
        if (typeof entry === 'string') return { localSessionId: entry };
        if (entry && typeof entry === 'object') {
          const obj = entry as Record<string, unknown>;
          const localSessionId = typeof obj.localSessionId === 'string'
            ? obj.localSessionId
            : typeof obj.id === 'string'
              ? obj.id
              : '';
          const serverSessionId = typeof obj.serverSessionId === 'string' ? obj.serverSessionId : undefined;
          if (localSessionId) return { localSessionId, serverSessionId };
        }
        return null;
      })
      .filter((entry): entry is AttachedOpenCodeSession => !!entry);
  } catch { return []; }
}

function saveAttachedSessions(sessions: AttachedOpenCodeSession[]): void {
  try {
    const byLocal = new Map<string, AttachedOpenCodeSession>();
    for (const s of sessions) {
      byLocal.set(s.localSessionId, s);
    }
    writeFileSync(getAttachedStoragePath(), JSON.stringify([...byLocal.values()]), 'utf-8');
  } catch {}
}

/** Discover the OpenCode port from running process. Used for reconnect. */
function discoverOpenCodePortLocal(): number | null {
  try {
    const cp = require('node:child_process');
    if (process.platform === 'win32') {
      for (const query of ['opencode', 'node']) {
        try {
          const out = cp.execSync(
            `wmic process where "name like '%${query}%'" get CommandLine /format:list`,
            { encoding: 'utf-8', timeout: 5000 },
          );
          const all = [...out.matchAll(/--port\s+(\d+)/g)];
          if (all.length > 0) return Number(all[all.length - 1][1]);
        } catch { /* try next query */ }
      }
    } else {
      const out = cp.execSync('ps aux | grep -v grep | grep -E "opencode|node.*opencode"', {
        encoding: 'utf-8', timeout: 5000,
      });
      const m = out.match(/--port\s+(\d+)/);
      if (m) return Number(m[1]);
    }
  } catch { /* fall through */ }
  return null;
}

export class OpenCodeSessionManager {
  private bridge: ApprovalBridge;
  private opencodeBaseUrl: string;
  private _port: number;

  private opencodeSessions: Set<string> = new Set();
  private opencodeSessionToRelayId: Map<string, string> = new Map();
  private inFlightSessions: Map<string, Promise<string>> = new Map();
  private permissionMap: Map<string, { requestID: string; serverSessionId: string; localSessionID: string }> = new Map();
  private deliveredMessageParts: Set<string> = new Set();
  /** Track recently sent phone commands to avoid echoing them back. */
  private recentPhoneTexts = new Map<string, { text: string; expiresAt: number }>();

  private _abortController: AbortController | null = null;
  private _stopped = false;
  private _reconnectDelay = INITIAL_RECONNECT_DELAY;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opencodeBaseUrl: string, bridge: ApprovalBridge) {
    this.opencodeBaseUrl = opencodeBaseUrl;
    this._port = parseInt(new URL(opencodeBaseUrl).port, 10) || 4096;
    this.bridge = bridge;
  }

  ownsSession(serverSessionId: string): boolean {
    return this.opencodeSessions.has(serverSessionId);
  }

  /** Register a session mapping so command routing works. Called from attach endpoint. */
  registerSession(localSessionId: string, serverSessionId: string): void {
    this.opencodeSessions.add(serverSessionId);
    this.opencodeSessionToRelayId.set(localSessionId, serverSessionId);
  }

  async start(): Promise<void> {
    this.bridge.registerExternalApprovalResponder({
      agentType: 'opencode',
      onApprovalForward: (eventId, decision, clientEventId) =>
        this.handleApprovalForward(eventId, decision, clientEventId),
    });

    this.bridge.registerAgentCommandHandler({
      ownsSession: (sid) => this.opencodeSessions.has(sid),
      handleCommand: (payload) => this.handleCommand(payload.sessionId, payload.data, payload.claudeSessionId || ''),
    });

    this.bridge.onEventAck((clientEventId, serverEventId) => {
      const entry = this.permissionMap.get(clientEventId);
      if (entry) {
        this.permissionMap.set(serverEventId, entry);
      }
    });

    // Register session mapping callback — fires on reconcile + attach
    this.bridge._onOpenCodeRegistered = (localId, serverId) => {
      this.registerSession(localId, serverId);
    };

    this._abortController = new AbortController();
    this._stopped = false;
    this._reconnectDelay = INITIAL_RECONNECT_DELAY;

    // Restore previously attached opencode session IDs from disk.
    for (const session of loadAttachedSessions()) {
      this.bridge.addOpenCodeAttachedSession(session.localSessionId);
      if (session.serverSessionId) {
        this.opencodeSessions.add(session.serverSessionId);
        this.opencodeSessionToRelayId.set(session.localSessionId, session.serverSessionId);
      }
    }

    await this.connectSSE();
  }

  stop(): void {
    this._stopped = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._abortController) {
      this._abortController.abort();
      this._abortController = null;
    }
    this.opencodeSessions.clear();
    this.opencodeSessionToRelayId.clear();
    this.inFlightSessions.clear();
    this.permissionMap.clear();
    this.deliveredMessageParts.clear();
  }

  async attachSession(localSessionId: string, title?: string): Promise<string> {
    const fetchMessages = (sid: string): Promise<any[]> => {
      return fetch(`${this.opencodeBaseUrl}/session/${encodeURIComponent(sid)}/message?limit=5`)
        .then(r => r.ok ? r.json() as Promise<any[]> : Promise.resolve([]))
        .catch((): any[] => []);
    };
    return this.bridge.attachOpenCodeSession(localSessionId, fetchMessages, title, (localId, serverId) => {
      this.registerSession(localId, serverId);
      saveAttachedSessions([...loadAttachedSessions(), { localSessionId: localId, serverSessionId: serverId }]);
    });
  }

  async detachSession(localSessionId: string, knownServerSessionId?: string): Promise<boolean> {
    if (knownServerSessionId) {
      this.opencodeSessions.add(knownServerSessionId);
      this.opencodeSessionToRelayId.set(localSessionId, knownServerSessionId);
    }
    const serverSessionId = await this.ensureRelaySession(localSessionId);
    this.bridge.removeOpenCodeAttachedSession(localSessionId);
    saveAttachedSessions(loadAttachedSessions().filter(s => s.localSessionId !== localSessionId));
    this.bridge.relay.sendRaw(JSON.stringify({
      type: 'deactivate_session',
      payload: { sessionId: serverSessionId },
    }));
    return true;
  }

  /** Fetch recent messages and push as relay events. */
  private async replayHistory(localSessionId: string, serverSessionId: string): Promise<void> {
    const url = `${this.opencodeBaseUrl}/session/${encodeURIComponent(localSessionId)}/message?limit=5`;
    console.error('[opencode] replayHistory: fetching %s', url);
    try {
      const resp = await fetch(url);
      if (!resp.ok) { console.error('[opencode] replayHistory: %s %s', resp.status, resp.statusText); return; }
      const msgs = await resp.json() as any[];
      if (!Array.isArray(msgs)) { console.error('[opencode] replayHistory: unexpected response type'); return; }
      console.error('[opencode] replayHistory: got %d messages', msgs.length);

      for (const m of msgs) {
        const info = m.info || {};
        if (info.role === 'user' && Array.isArray(m.parts)) {
          const text = m.parts
            .filter((p: any) => p.type === 'text' && p.text)
            .map((p: any) => p.text)
            .join('\n');
          if (text) {
            this.bridge.sendEventToRelay(serverSessionId, {
              clientEventId: `oc-hist:${localSessionId}:${Date.now()}:${Math.random()}`,
              sessionId: serverSessionId,
              agent: 'opencode',
              eventType: 'user_prompt',
              data: { type: 'user_prompt', prompt: text, summary: text.slice(0, 200) },
              ts: info.time?.created ? new Date(info.time.created).toISOString() : new Date().toISOString(),
            });
          }
        } else if (info.role === 'assistant' && m.parts) {
          const text = m.parts
            .filter((p: any) => p.type === 'text' && p.text)
            .map((p: any) => p.text)
            .join('\n');
          if (text) {
            this.bridge.sendEventToRelay(serverSessionId, {
              clientEventId: `oc-hist:${localSessionId}:${Date.now()}:${Math.random()}`,
              sessionId: serverSessionId,
              agent: 'opencode',
              eventType: 'task_complete',
              data: { type: 'task_complete', summary: text.slice(0, 500), output: text.slice(0, 500) },
              ts: info.time?.completed || info.time?.created ? new Date((info.time.completed || info.time.created) as number).toISOString() : new Date().toISOString(),
            });
          }
        }
      }
    } catch (err: any) { console.error('[opencode] replayHistory error: %s', err.message || err); }
  }

  private ensureRelaySession(localSessionId: string): Promise<string> {
    const existing = this.opencodeSessionToRelayId.get(localSessionId);
    if (existing) return Promise.resolve(existing);

    const inFlight = this.inFlightSessions.get(localSessionId);
    if (inFlight) return inFlight;

    const promise = this.bridge.ensureSession(localSessionId, undefined, 'opencode', {
      agentType: 'opencode',
      runtime: 'opencode',
    }).then((serverSessionId) => {
      this.opencodeSessions.add(serverSessionId);
      this.opencodeSessionToRelayId.set(localSessionId, serverSessionId);
      return serverSessionId;
    }).finally(() => {
      this.inFlightSessions.delete(localSessionId);
    });

    this.inFlightSessions.set(localSessionId, promise);
    return promise;
  }

  // ── SSE connection ──────────────────────────────────────

  private scheduleReconnect(): void {
    if (this._stopped) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // Re-discover port on reconnect (OpenCode may have restarted)
    const newPort = discoverOpenCodePortLocal();
    if (newPort && newPort !== this._port) {
      const newUrl = `http://127.0.0.1:${newPort}`;
      console.error('[opencode] port changed %d -> %d, switching', this._port, newPort);
      this.opencodeBaseUrl = newUrl;
      this._port = newPort;
    }
    const delay = this._reconnectDelay;
    this._reconnectDelay = Math.min(
      this._reconnectDelay * BACKOFF_MULTIPLIER,
      MAX_RECONNECT_DELAY,
    );
    console.error('[opencode] SSE reconnecting in %dms (port=%d)', delay, this._port);
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      if (!this._stopped) this.connectSSE().catch(() => {});
    }, delay);
  }

  private resetBackoff(): void {
    this._reconnectDelay = INITIAL_RECONNECT_DELAY;
  }

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
            if (!this._stopped) this.scheduleReconnect();
            return;
          }
          resolve();
          this.resetBackoff();

          const parser = createEventStreamParser();
          res.on('data', (chunk: Buffer) => {
            const events = parser.feed(chunk.toString('utf-8'));
            for (const evt of events) {
              this.handleSSEEvent(evt).catch((err) => {
                console.error('[opencode] SSE event handler error:', err);
              });
            }
          });
          res.on('error', (_err) => {
            if (!this._stopped) {
              this.scheduleReconnect();
            }
          });
          res.on('end', () => {
            if (!this._stopped) {
              this.scheduleReconnect();
            }
          });
        },
      );

      req.on('error', (err) => {
        if (!this._stopped) {
          console.error('[opencode] SSE connection error:', err.message);
          this.scheduleReconnect();
        }
        reject(err);
      });
    });
  }

  // ── Event dispatch ──────────────────────────────────────

  public async handleSSEEvent(event: { type: string; properties: Record<string, unknown> }): Promise<void> {
    // Log all events briefly for debugging
    if (event.type.startsWith('message') || event.type.startsWith('permission')) {
      console.error('[opencode] SSE: %s (session=%s)', event.type, (event.properties as any)?.sessionID || (event.properties as any)?.part?.sessionID || '?');
    }
    switch (event.type) {
      case 'server.connected':
        return;
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

  private async onPermissionUpdated(props: Record<string, unknown>): Promise<void> {
    const requestID = props.id as string;
    const sessionID = props.sessionID as string;
    const permissionType = props.type as string;
    const title = props.title as string;
    const metadata = (props.metadata as Record<string, unknown>) ?? {};

    if (!requestID || !sessionID) return;

    const serverSessionId = await this.ensureRelaySession(sessionID);

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

  private onPermissionReplied(_props: Record<string, unknown>): void {}

  // ── Session lifecycle ───────────────────────────────────

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

  private onSessionIdle(props: Record<string, unknown>): void {
    const sessionID = props.sessionID as string;
    if (!sessionID) return;
    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    // OpenCode sometimes carries an error payload on session.idle even
    // when no separate session.error event was emitted (e.g. the agent
    // hit a max-iteration cap and gave up). Surface it as a proper
    // error event so the phone can show the reason — otherwise the
    // user only sees a generic "Session idle" and has no idea why the
    // task ended without completing.
    const errorObj = props.error as Record<string, unknown> | undefined;
    if (errorObj) {
      const message = (errorObj.message as string) || 'Session idle with error';
      this.bridge.sendEventToRelay(serverSessionId, {
        sessionId: serverSessionId,
        agent: 'opencode',
        eventType: 'error',
        data: { type: 'error', message },
      });
    }

    this.bridge.sendEventToRelay(serverSessionId, {
      sessionId: serverSessionId,
      agent: 'opencode',
      eventType: 'task_complete',
      data: {
        type: 'task_complete',
        summary: errorObj ? (errorObj.message as string) || 'Session idle with error' : 'Session idle',
      },
    });
  }

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

  private onMessageUpdated(props: Record<string, unknown>): void {
    const info = props.info as Record<string, unknown> | undefined;
    if (!info) return;
    const messageID = info.id as string;
    const sessionID = info.sessionID as string;
    if (!messageID || !sessionID) return;

    const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) return;

    const key = `msg:${messageID}`;
    if (this.deliveredMessageParts.has(key)) return;
    this.deliveredMessageParts.add(key);

    if (this.deliveredMessageParts.size > 10000) {
      const arr = [...this.deliveredMessageParts];
      this.deliveredMessageParts = new Set(arr.slice(-5000));
    }

    // User message typed in TUI: emit as user_prompt
    if (info.role === 'user') {
      const summary = info.summary as Record<string, unknown> | undefined;
      const text = (summary?.body as string) || (summary?.title as string) || '';
      if (text && !this._isRecentPhoneCommand(sessionID, text)) {
        this.bridge.sendEventToRelay(serverSessionId, {
          clientEventId: `oc-user:${messageID}:${Date.now()}`,
          sessionId: serverSessionId,
          agent: 'opencode',
          eventType: 'user_prompt',
          data: { type: 'user_prompt', prompt: text, summary: text.slice(0, 200) },
          ts: new Date().toISOString(),
        });
      }
      return;
    }

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

  private onMessagePartUpdated(props: Record<string, unknown>): void {
    const part = props.part as Record<string, unknown> | undefined;
    if (!part) return;

    const sessionID = part.sessionID as string;
    const messageID = part.messageID as string;
    const partID = part.id as string;
    const partType = part.type as string;

    if (!sessionID || !messageID) return;
    let serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
    if (!serverSessionId) {
      // Auto-register on first response — CC does this via hook events
      console.error('[opencode] onMessagePartUpdated: registering session %s on-the-fly', sessionID);
      this.ensureRelaySession(sessionID).then((sid) => {
        // Defer — next SSE event for this session will find the mapping
      }).catch(() => {});
      return;
    }

    const key = `part:${partID}`;
    if (this.deliveredMessageParts.has(key)) return;

    if (partType === 'text') {
      this.deliveredMessageParts.add(key);
      const text = (part.text as string) || (props.delta as string) || '';
      if (!text) return;

      // Suppress the text-part echo of a phone-sent prompt. OpenCode
      // surfaces the user input as a text part on the user message
      // before any assistant reply; without this check, the phone
      // sees the same string twice — once as its own user_prompt and
      // once as a task_complete marked as the agent's reply.
      if (this._isRecentPhoneCommand(sessionID, text)) return;

      this.bridge.sendEventToRelay(serverSessionId, {
        clientEventId: `oc-part:${partID}:${Date.now()}`,
        sessionId: serverSessionId,
        agent: 'opencode',
        eventType: 'task_complete',
        data: {
          type: 'task_complete',
          summary: text.slice(0, 500),
          summaryShort: text.slice(0, 200),
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

  async handleCommand(sessionId: string, text: string, claudeSessionId?: string): Promise<void> {
    const opencodeSessionId = claudeSessionId || this.resolveLocalSessionId(sessionId) || sessionId;
    console.error('[opencode] handleCommand: sessionId=%s opencodeSessionId=%s', sessionId.slice(0, 8), opencodeSessionId.slice(0, 8));

    // Ensure mapping exists for SSE event forwarding
    if (claudeSessionId && !this.opencodeSessionToRelayId.has(claudeSessionId)) {
      this.registerSession(claudeSessionId, sessionId);
    }

    // Track this text so onMessageUpdated doesn't echo it back
    this._trackPhoneCommand(opencodeSessionId, text);

    // Emit user_prompt FIRST so phone sees the command
    this.bridge.sendEventToRelay(sessionId, {
      clientEventId: `oc-phone:${Date.now()}:${Math.random()}`,
      sessionId,
      agent: 'opencode',
      eventType: 'user_prompt',
      data: { type: 'user_prompt', prompt: text, summary: text.slice(0, 200) },
      ts: new Date().toISOString(),
    });

    try {
      const url = `${this.opencodeBaseUrl}/session/${encodeURIComponent(opencodeSessionId)}/prompt_async`;
      console.error('[opencode] handleCommand: POST %s', url);
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          parts: [{ type: 'text', text }],
        }),
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`OpenCode prompt_async returned ${resp.status}: ${text}`);
      }
      console.error('[opencode] handleCommand: prompt sent OK');
    } catch (err) {
      console.error('[opencode] handleCommand: %s', (err as Error).message);
      this.bridge.sendErrorToRelay(sessionId, `命令发送失败: ${err}`);
    }
  }

  private _trackPhoneCommand(sessionID: string, text: string): void {
    const fingerprint = text.trim().slice(0, 40);
    if (!fingerprint) return;
    this.recentPhoneTexts.set(`${sessionID}:${fingerprint}`, { text, expiresAt: Date.now() + 30_000 });
  }

  private _isRecentPhoneCommand(sessionID: string, text: string): boolean {
    // Non-consuming check: the entry is removed only by the TTL
    // sweeper. We have two call sites (message.updated for the TUI
    // echo AND message.part.updated for the text-part echo) and the
    // order in which OpenCode emits them is not guaranteed, so each
    // site must see the entry. Same text repeating within 30s is
    // almost always the same echoed prompt — suppressing all of them
    // is the correct behaviour.
    const fingerprint = text.trim().slice(0, 40);
    const entry = this.recentPhoneTexts.get(`${sessionID}:${fingerprint}`);
    if (!entry) return false;
    if (Date.now() > entry.expiresAt) {
      this.recentPhoneTexts.delete(`${sessionID}:${fingerprint}`);
      return false;
    }
    return true;
  }

  private resolveLocalSessionId(serverSessionId: string): string | null {
    for (const [local, server] of this.opencodeSessionToRelayId) {
      if (server === serverSessionId) return local;
    }
    return null;
  }
}

function permissionToCommand(permissionType: string, metadata: Record<string, unknown>): string {
  if (metadata.command) return metadata.command as string;
  if (metadata.filePath) return `${permissionType} ${metadata.filePath}`;
  if (metadata.patch) return `${permissionType} (patch: ${(metadata.patch as string).slice(0, 50)})`;
  return permissionType;
}
