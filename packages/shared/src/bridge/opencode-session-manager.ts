import { randomUUID } from 'node:crypto';
import { get as httpGet } from 'node:http';
import { createEventStreamParser } from './sse-parser.js';
import { ApprovalBridge } from './handler.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { discoverOpenCodePort } from './platform.js';
import { tryFormatInputRequiredEvent } from './input-card.js';

interface OpenCodeSessionInfo {
  id: string;
  title?: string;
  directory?: string;
  time?: { created?: number; updated?: number };
}

const INITIAL_RECONNECT_DELAY = 1000;
const MAX_RECONNECT_DELAY = 30_000;
const BACKOFF_MULTIPLIER = 2;

function getOpenCodeDataDir(): string {
  return process.env.OPENCODE_DATA_DIR || join(homedir(), '.local', 'share', 'opencode');
}

export function discoverLocalOpenCodeSessions(limit = 50): OpenCodeSessionInfo[] {
  const sessionRoot = join(getOpenCodeDataDir(), 'storage', 'session');
  try {
    if (!existsSync(sessionRoot)) return [];
    const sessions: Array<OpenCodeSessionInfo & { _sortTime: number }> = [];
    for (const project of readdirSync(sessionRoot, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const projectDir = join(sessionRoot, project.name);
      for (const file of readdirSync(projectDir, { withFileTypes: true })) {
        if (!file.isFile() || !/^ses_.*\.json$/.test(file.name)) continue;
        const filePath = join(projectDir, file.name);
        try {
          const parsed = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
          const id = typeof parsed.id === 'string' ? parsed.id : file.name.replace(/\.json$/, '');
          if (!id) continue;
          // Skip subagent sessions: OpenCode creates internal sessions for
          // @explore, @general, etc. They have a 'subagent' field or their
          // title contains '@' or 'subagent' (case-insensitive).
          if (parsed.subagent || parsed.type === 'subagent') continue;
          const rawTitle = normalizeOpenCodeTitle(parsed.title);
          const rawMetaTitle = normalizeOpenCodeTitle((parsed.metadata as Record<string, unknown> | undefined)?.title);
          if ((rawTitle && /[@]|subagent/i.test(rawTitle)) ||
              (rawMetaTitle && /[@]|subagent/i.test(rawMetaTitle))) continue;
          const time = parsed.time && typeof parsed.time === 'object'
            ? parsed.time as { created?: number; updated?: number }
            : undefined;
          const stat = statSync(filePath);
          sessions.push({
            id,
            title: normalizeOpenCodeTitle(parsed.title),
            directory: typeof parsed.directory === 'string' ? parsed.directory : undefined,
            time,
            _sortTime: typeof time?.updated === 'number' ? time.updated : stat.mtimeMs,
          });
        } catch {}
      }
    }
    return sessions
      .sort((a, b) => b._sortTime - a._sortTime)
      .slice(0, limit)
      .map(({ _sortTime, ...session }) => session);
  } catch {
    return [];
  }
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
      onApprovalForward: (eventId, decision, clientEventId, sessionId) =>
        this.handleApprovalForward(eventId, decision, clientEventId, sessionId),
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

  async attachSession(localSessionId: string, title?: string, knownServerSessionId?: string): Promise<string> {
    const fetchMessages = (sid: string): Promise<any[]> => {
      return fetch(`${this.opencodeBaseUrl}/session/${encodeURIComponent(sid)}/message?limit=5`)
        .then(r => r.ok ? r.json() as Promise<any[]> : Promise.resolve([]))
        .catch((): any[] => []);
    };
    return this.bridge.attachOpenCodeSession(localSessionId, fetchMessages, normalizeOpenCodeTitle(title), (localId, serverId) => {
      this.registerSession(localId, serverId);
    }, knownServerSessionId);
  }

  async listSessions(limit = 50): Promise<OpenCodeSessionInfo[]> {
    const httpSessions = await this.fetchOpenCodeSessions();
    // When OpenCode is not running, return empty — don't show stale disk sessions.
    if (httpSessions === null) return [];

    const localSessions = discoverLocalOpenCodeSessions(limit);
    const byId = new Map(localSessions.map((session) => [session.id, session]));
    for (const session of httpSessions) {
      if (!session.id) continue;
      const local = byId.get(session.id);
      byId.set(session.id, {
        ...local,
        ...session,
        title: normalizeOpenCodeTitle(session.title) || local?.title,
      });
    }
    return [...byId.values()]
      .sort((a, b) => (b.time?.updated ?? 0) - (a.time?.updated ?? 0))
      .slice(0, limit);
  }

  private async fetchOpenCodeSessions(): Promise<OpenCodeSessionInfo[] | null> {
    try {
      const resp = await fetch(`${this.opencodeBaseUrl}/session`);
      if (!resp.ok) return null;
      const sessions = await resp.json() as unknown;
      if (!Array.isArray(sessions)) return null;
      return sessions
        .map((session) => {
          if (typeof session === 'string') return { id: session };
          if (session && typeof session === 'object') {
            const obj = session as Record<string, unknown>;
            const id = typeof obj.id === 'string' ? obj.id : '';
            if (!id) return null;
            return obj as unknown as OpenCodeSessionInfo;
          }
          return null;
        })
        .filter((session): session is OpenCodeSessionInfo => !!session);
    } catch {
      return null;
    }
  }

  async detachSession(localSessionId: string, knownServerSessionId?: string): Promise<boolean> {
    if (knownServerSessionId) {
      this.opencodeSessions.add(knownServerSessionId);
      this.opencodeSessionToRelayId.set(localSessionId, knownServerSessionId);
    }
    const serverSessionId = await this.ensureRelaySession(localSessionId);
    this.bridge.removeOpenCodeAttachedSession(localSessionId);

    // Arm waiter BEFORE sending so a fast ack cannot be missed. Awaiting the
    // ack before returning prevents a quick re-attach from racing the
    // deactivate against a fresh register_session at the relay.
    const ackPromise = this.bridge.waitForSessionDeactivated(serverSessionId, 3000);

    this.bridge.relay.sendRaw(JSON.stringify({
      type: 'deactivate_session',
      payload: { sessionId: serverSessionId, reason: 'manual_detach' },
    }));

    await ackPromise;
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
              data: { type: 'task_complete', summary: text, summaryShort: text.slice(0, 200), output: text },
              ts: info.time?.completed || info.time?.created ? new Date((info.time.completed || info.time.created) as number).toISOString() : new Date().toISOString(),
            });
          }
        }
      }
    } catch (err: any) { console.error('[opencode] replayHistory error: %s', err.message || err); }
  }

  private ensureRelaySession(localSessionId: string, providedTitle?: string): Promise<string> {
    const existing = this.opencodeSessionToRelayId.get(localSessionId);
    if (existing) return Promise.resolve(existing);

    const inFlight = this.inFlightSessions.get(localSessionId);
    if (inFlight) return inFlight;

    const options: { agentType: string; runtime: string; title?: string } = {
      agentType: 'opencode',
      runtime: 'opencode',
    };
    if (providedTitle) options.title = providedTitle;

    const promise = this.bridge.ensureSession(localSessionId, undefined, 'opencode', options).then((serverSessionId) => {
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

  /** Re-discover OpenCode's port and update the cached baseUrl if changed.
   *  Cheap (just reads a file via discoverOpenCodePort). Safe to call before
   *  any HTTP fetch — OpenCode may have restarted between an approval event
   *  arriving via SSE and the phone's reply coming back, in which case the
   *  SSE might not have reconnected yet but the fetch still needs the new
   *  port. */
  private refreshOpenCodeUrl(): void {
    const newPort = discoverOpenCodePort();
    if (newPort && newPort !== this._port) {
      const newUrl = `http://127.0.0.1:${newPort}`;
      console.error('[opencode] refreshOpenCodeUrl: port changed %d -> %d', this._port, newPort);
      this.opencodeBaseUrl = newUrl;
      this._port = newPort;
    }
  }

  private scheduleReconnect(): void {
    if (this._stopped) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    // Re-discover port on reconnect (OpenCode may have restarted)
    this.refreshOpenCodeUrl();
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
      case 'permission.asked':
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
    // requestID and permissionType field names have changed across OpenCode
    // versions. Accept all known candidates so a new build doesn't silently
    // drop permission events as malformed (which leaves the phone waiting
    // forever and surfaces as "approval callback failed" on retry).
    const requestID = (props.id || props.requestID || props.permissionID
      || props.permissionId || props.permission_id) as string;
    const sessionID = props.sessionID as string;
    const permissionType = (props.type || props.permission
      || props.permissionType || props.permission_type) as string;
    const title = props.title as string;
    const metadata = (props.metadata as Record<string, unknown>) ?? {};

    if (!requestID || !sessionID || !permissionType) return;

    const serverSessionId = await this.ensureRelaySession(sessionID);

    const command = permissionToCommand(permissionType, metadata);
    const rawRisk = this.bridge.evaluateRisk(command);
    const risk = rawRisk === 'unknown' ? 'medium' : rawRisk;

    const clientEventId = `oc-perm:${requestID}`;

    // Resolve any existing pending approvals for this session before issuing
    // a new one — mirrors CC's handleApproval (handler.ts:1126-1135). Without
    // this cleanup, old pending approvals accumulate and the phone cannot
    // approve any of them (handleApprovalForward lookup fails because
    // permissionMap entries get overwritten or the phone sees stale events).
    for (const [key, entry] of this.permissionMap) {
      if (entry.serverSessionId === serverSessionId) {
        this.bridge.resolveTrackedApproval(key);
        this.permissionMap.delete(key);
      }
    }

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

  private onPermissionReplied(props: Record<string, unknown>): void {
    const requestID = (props.id || props.requestID || props.permissionID
      || props.permissionId || props.permission_id) as string;
    if (!requestID) return;
    const clientEventId = `oc-perm:${requestID}`;
    const entry = this.permissionMap.get(clientEventId);
    if (entry) {
      const resolved = this.bridge.resolveTrackedApproval(clientEventId);
      if (!resolved) {
        console.error('[opencode] permission.replied had local mapping but no tracked approval: %s', clientEventId);
      }
      for (const [key, value] of this.permissionMap) {
        if (value === entry) this.permissionMap.delete(key);
      }
      return;
    }
    this.permissionMap.delete(clientEventId);
  }

  // ── Session lifecycle ───────────────────────────────────

  private onSessionEvent(type: string, props: Record<string, unknown>): void {
    const info = props.info as Record<string, unknown> | undefined;
    if (!info) return;
    const sessionID = info.id as string;
    if (!sessionID) return;

    if (type === 'session.updated') {
      const serverSessionId = this.opencodeSessionToRelayId.get(sessionID);
      const title = extractOpenCodeSessionTitle(info);
      if (serverSessionId && title) {
        this.bridge.relay.sendRaw(JSON.stringify({
          type: 'update_session_label',
          payload: { sessionId: serverSessionId, label: title },
        }));
      }
    } else if (type === 'session.deleted') {
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

    const inputCard = tryFormatInputRequiredEvent(info, 'opencode');
    if (inputCard) {
      this.bridge.sendEventToRelay(serverSessionId, {
        clientEventId: inputCard.requestId || `oc-input:${messageID}`,
        sessionId: serverSessionId,
        agent: 'opencode',
        eventType: 'input_required',
        data: inputCard,
      });
      return;
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

    // Check for input_required BEFORE the unmapped-session gate — approvals
    // need to auto-register (same as CC's handleApproval), but regular
    // text/tool events for unmapped sessions must NOT create new relay
    // sessions. Without this check, every assistant reply on any local
    // OpenCode session would appear as a new session on the phone.
    const key = `part:${partID}`;
    const inputCard = tryFormatInputRequiredEvent(part, 'opencode')
      || tryFormatInputRequiredEvent(props, 'opencode');

    if (!serverSessionId) {
      if (inputCard) {
        // Auto-register for approval events only — matches CC pattern
        console.error('[opencode] onMessagePartUpdated: auto-registering session %s for input_required', sessionID);
        this.ensureRelaySession(sessionID).then((sid) => {
          this.bridge.sendEventToRelay(sid, {
            clientEventId: inputCard.requestId || `oc-input:${partID || messageID}`,
            sessionId: sid,
            agent: 'opencode',
            eventType: 'input_required',
            data: inputCard,
          });
        }).catch(() => {});
      }
      // Skip all other events for unmapped sessions (text, tool, etc.)
      return;
    }

    if (this.deliveredMessageParts.has(key)) return;

    if (inputCard) {
      this.deliveredMessageParts.add(key);
      this.bridge.sendEventToRelay(serverSessionId, {
        clientEventId: inputCard.requestId || `oc-input:${partID || messageID}`,
        sessionId: serverSessionId,
        agent: 'opencode',
        eventType: 'input_required',
        data: inputCard,
      });
      return;
    }

    if (partType === 'text') {
      const text = (part.text as string) || (props.delta as string) || '';
      if (!text) return;

      // Dedup key includes the text content, not just the partID, so
      // streaming updates with growing text are not collapsed. The
      // previous key was `part:${partID}` alone, which had two
      // failure modes:
      //   1. OpenCode often creates a part with text="" first, then
      //      updates it with the real content. The old code added
      //      partID to the dedup set BEFORE the empty check, so the
      //      first event consumed the slot and the agent's actual
      //      response was dropped on the floor. The phone then only
      //      saw the generic "Session idle" task_complete.
      //   2. Streaming updates (text="H" → "He" → "Hello") were
      //      suppressed after the first chunk.
      // With the new key, same-content re-fires still dedup, but
      // empty-then-non-empty and incremental updates both pass.
      const dedupKey = `part:${partID}:${text}`;
      if (this.deliveredMessageParts.has(dedupKey)) return;
      this.deliveredMessageParts.add(dedupKey);

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
          summary: text,
          summaryShort: text.slice(0, 200),
          output: text,
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

  async handleApprovalForward(eventId: string, decision: string, clientEventId?: string, sessionId?: string): Promise<boolean> {
    let entry = this.permissionMap.get(eventId)
      ?? (clientEventId ? this.permissionMap.get(clientEventId) : undefined);

    // Fallback: permissionMap entry was lost (SSE reconnect). Try to
    // reconstruct it from the clientEventId format or sessionId mapping.
    if (!entry && clientEventId && clientEventId.startsWith('oc-perm:')) {
      const requestID = clientEventId.slice('oc-perm:'.length);
      let serverSessionId: string | undefined;
      // Look up serverSessionId using the approval eventId via
      // opencodeSessionToRelayId (localSessionId → serverSessionId).
      // sessionId from approval_forward is the DB session UUID.
      if (sessionId) {
        for (const [, sid] of this.opencodeSessionToRelayId) {
          if (sid === sessionId) { serverSessionId = sid; break; }
        }
      }
      if (!serverSessionId) serverSessionId = sessionId;
      if (serverSessionId) {
        const localSessionID = this.resolveLocalSessionId(serverSessionId) || serverSessionId;
        entry = { requestID, serverSessionId, localSessionID };
      }
    }

    if (!entry) return false;

    // Re-discover the port right before each approval forward. If OpenCode
    // restarted between the permission trigger and the phone decision, the SSE
    // may not have reconnected yet (or just reconnected with a new port), and
    // the cached this.opencodeBaseUrl would point at a dead port. discoverOpenCodePort
    // is cheap (just reads a file), so call it on every decision.
    this.refreshOpenCodeUrl();

    try {
      const reply = decision === 'approve' ? 'once' : 'reject';
      const newUrl = `${this.opencodeBaseUrl}/permission/${encodeURIComponent(entry.requestID)}/reply`;
      const resp = await fetch(newUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply }),
      });
      if (resp.status === 404 || resp.status === 410) {
        const legacyUrl = `${this.opencodeBaseUrl}/session/${encodeURIComponent(entry.localSessionID)}/permissions/${encodeURIComponent(entry.requestID)}`;
        const legacyResp = await fetch(legacyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: reply }),
        });
        if (!legacyResp.ok) throw new Error(`OpenCode reply (legacy ${legacyUrl}) returned ${legacyResp.status}`);
      } else if (!resp.ok) throw new Error(`OpenCode reply (${newUrl}) returned ${resp.status}`);
    } catch (err) {
      this.bridge.sendErrorToRelay(entry.serverSessionId, `审批回写失败: ${err}`);
      return true;
    }

    this.bridge.resolveEventOnRelay(eventId);
    if (clientEventId && clientEventId !== eventId) {
      this.bridge.resolveEventOnRelay(clientEventId);
    }
    this.bridge.resolveTrackedApproval(eventId, clientEventId);
    this.permissionMap.delete(eventId);
    if (clientEventId) this.permissionMap.delete(clientEventId);

    return true;
  }

  // ── Command handling ────────────────────────────────────

  async handleCommand(sessionId: string, text: string, claudeSessionId?: string): Promise<void> {
    const opencodeSessionId = claudeSessionId || this.resolveLocalSessionId(sessionId) || sessionId;
    console.error('[opencode] handleCommand: sessionId=%s opencodeSessionId=%s', sessionId.slice(0, 8), opencodeSessionId.slice(0, 8));

    // Re-discover port before fetch — same rationale as handleApprovalForward.
    this.refreshOpenCodeUrl();

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

function normalizeOpenCodeTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined;
  const trimmed = title.trim();
  if (!trimmed || /^ses_[a-f0-9]{8,}$/i.test(trimmed) || trimmed === 'OpenCode session') return undefined;
  return trimmed;
}

function extractOpenCodeSessionTitle(info: Record<string, unknown>): string | undefined {
  const candidates = [
    info.title,
    info.name,
    (info.metadata as Record<string, unknown> | undefined)?.title,
  ];
  for (const candidate of candidates) {
    const title = normalizeOpenCodeTitle(candidate);
    if (title) return title;
  }
  return undefined;
}
