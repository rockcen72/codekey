import { randomUUID } from 'node:crypto';
import type { RelayClient } from './relay-client.js';
import type { ApprovalBridge } from './handler.js';
import { cleanCodexDisplayText, discoverLocalSessions, findMostRecentSession, type CodexLocalSession } from './codex-local-session-resolver.js';
import { CodexResumeRuntime, type ResumeResult } from './codex-resume-runtime.js';
import { resolveCodexBinary } from './codex-binary.js';

/**
 * Manages Codex resume sessions: discovery, relay registration, command handling,
 * resume execution, and event forwarding.
 *
 * Each resumed session gets its own CodexResumeRuntime instance so cwd is correct
 * per session. The manager owns command routing for resumed sessions and notifies
 * ApprovalBridge via a shared resumedServerSessionIds Set to skip its command queue.
 */
export class CodexResumeManager {
  private relay: RelayClient;
  /** Shared Set of server session IDs that should NOT enter ApprovalBridge's command queue. */
  private resumedServerSessionIds: Set<string>;
  /** serverSessionId → session state */
  private sessions = new Map<string, ResumeSessionState>();
  /** Codex local session UUID → serverSessionId */
  private localToServer = new Map<string, string>();
  /** In-flight registration promises keyed by local session id */
  private inFlightRegistrations = new Map<string, Promise<string>>();
  /** Pending register_session callbacks keyed by clientRequestId */
  private pendingClientRequests = new Map<string, (sid: string) => void>();

  private _listening = false;

  private approvalBridge: ApprovalBridge | null = null;
  private storagePath: string | null = null;

  constructor(relay: RelayClient, resumedServerSessionIds: Set<string>, approvalBridge?: ApprovalBridge, storagePath?: string) {
    this.relay = relay;
    this.resumedServerSessionIds = resumedServerSessionIds;
    this.approvalBridge = approvalBridge ?? null;
    this.storagePath = storagePath ?? null;

    // Load previously resumed session IDs from storage
    if (this.storagePath) {
      this._loadPersistedIds().catch(() => {});
    }

    // Listen for session_registered to resolve pending registrations
    this.relay.on('session_registered', (payload: unknown) => {
      const p = payload as { clientRequestId?: string; sessionId: string };
      if (p.clientRequestId) {
        const resolve = this.pendingClientRequests.get(p.clientRequestId);
        if (resolve) {
          this.pendingClientRequests.delete(p.clientRequestId);
          resolve(p.sessionId);
        }
      }
    });
  }

  /** Start listening for relay commands targeting resumed sessions. */
  startListening(): void {
    if (this._listening) return;
    this._listening = true;

    this.relay.on('command', (payload: { sessionId?: string; action: string; data: string }) => {
      if (payload.action !== 'write_stdin') return;
      if (!payload.sessionId) return;
      if (!this.resumedServerSessionIds.has(payload.sessionId)) return;

      this.handleCommand(payload.sessionId, payload.data).catch((err) => {
        console.error('[codex-resume] command error:', err);
      });
    });
  }

  /**
   * Discover local Codex sessions.
   */
  discoverSessions(limit = 20, cwd?: string): CodexLocalSession[] {
    return discoverLocalSessions(limit, cwd);
  }

  /**
   * Start resuming a Codex session.
   *
   * Flow:
   *   1. Register session on relay (send register_session with agentType='codex')
   *   2. Wait for session_registered ack → get serverSessionId
   *   3. Add serverSessionId to resumedServerSessionIds Set
   *   4. Create per-session CodexResumeRuntime
   */
  async startResume(localSession: CodexLocalSession): Promise<string> {
    // Dedup: already resuming or resumed
    const existing = this.localToServer.get(localSession.sessionId);
    if (existing) return existing;

    const inFlight = this.inFlightRegistrations.get(localSession.sessionId);
    if (inFlight) return inFlight;

    const promise = this._startResumeInner(localSession);
    this.inFlightRegistrations.set(localSession.sessionId, promise);

    try {
      const serverSessionId = await promise;
      this.inFlightRegistrations.delete(localSession.sessionId);
      return serverSessionId;
    } catch (err) {
      this.inFlightRegistrations.delete(localSession.sessionId);
      throw err;
    }
  }

  private async _startResumeInner(localSession: CodexLocalSession): Promise<string> {
    // Step 1: Resolve codex binary FIRST — fail early, no orphan session
    let binaryPath: string;
    try {
      const envPath = process.env.CODEX_BINARY_PATH;
      if (envPath) {
        binaryPath = envPath;
      } else {
        const { existsSync } = await import('node:fs');
        const { delimiter } = await import('node:path');
        const resolved = resolveCodexBinary({
          pathEntries: (process.env.PATH || '').split(delimiter),
          platform: process.platform as 'win32' | 'linux' | 'darwin',
          fs: { existsSync },
        });
        if (!resolved) throw new Error('codex binary not found on PATH');
        binaryPath = resolved;
      }
    } catch (err) {
      throw new Error(`Failed to resolve codex binary: ${err}`);
    }

    // Step 2: Register session on relay (may fail → no orphan since binary is already resolved)
    const serverSessionId = await this._registerOnRelay(localSession);

    // Step 3: Add to shared set so ApprovalBridge skips this session's commands
    this.resumedServerSessionIds.add(serverSessionId);

    // Step 4: Create per-session runtime with configurable sandbox/approval
    const sandbox = process.env.CODEX_RESUME_SANDBOX || 'workspace-write';
    const approvalPolicy = process.env.CODEX_RESUME_APPROVAL_POLICY || 'on-request';
    const runtime = new CodexResumeRuntime({
      binaryPath,
      cwd: localSession.cwd || process.cwd(),
      timeoutMs: 120_000,
      sandbox,
      approvalPolicy,
    });

    this.sessions.set(serverSessionId, { localSession, runtime });
    this.localToServer.set(localSession.sessionId, serverSessionId);

    // Register with ApprovalBridge so getAttachedSessionIds() includes this session (like CC)
    this.approvalBridge?.addCodexAttachedSession(localSession.sessionId);

    // Push last 3 transcript messages to relay so phone has minimal context
    this._forwardRecentHistory(serverSessionId, localSession.transcriptPath).catch(() => {});

    // Persist resumed session IDs so state survives bridge restart
    this._savePersistedIds();

    console.error('[codex-resume] started: local=%s server=%s cwd=%s', localSession.sessionId, serverSessionId, localSession.cwd);
    return serverSessionId;
  }

  /**
   * Handle a command (write_stdin) from relay for a resumed session.
   */
  async handleCommand(serverSessionId: string, prompt: string): Promise<void> {
    const state = this.sessions.get(serverSessionId);
    if (!state) {
      console.error('[codex-resume] command for unknown session: %s', serverSessionId);
      return;
    }

    // Forward user_prompt to relay so mini-program shows it
    this._forwardEvent(serverSessionId, {
      type: 'event',
      payload: {
        clientEventId: `phone:${serverSessionId}:${Date.now()}`,
        sessionId: serverSessionId,
        agent: 'codex',
        eventType: 'user_prompt',
        data: { type: 'user_prompt', prompt, summary: prompt.slice(0, 200) },
        ts: new Date().toISOString(),
      },
    });

    // Execute resume
    const result = await state.runtime.resumeOnce(state.localSession.sessionId, prompt);
    this._forwardResumeResult(serverSessionId, result);
  }

  /**
   * Forward resume result events to relay.
   * Always forwards available structured events first, then appends
   * a final error event if the process did not complete successfully.
   */
  private _forwardResumeResult(serverSessionId: string, result: ResumeResult): void {
    // 1. Forward all structured events from the JSONL output
    for (const event of result.events) {
      if (event.type === 'message' && event.role === 'assistant') {
        const text = cleanCodexDisplayText(event.content || '');
        if (!text) continue;
        this._forwardEvent(serverSessionId, {
          type: 'event',
          payload: {
            clientEventId: `resume:${serverSessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
            sessionId: serverSessionId,
            agent: 'codex',
            eventType: 'task_complete',
            data: { type: 'task_complete', summary: text, output: text },
            ts: new Date().toISOString(),
          },
        });
      } else if (event.type === 'tool' && event.toolStatus === 'failed') {
        // Check raw event status for precise declined detection
        const raw = event.raw as Record<string, unknown>;
        const rawItem = raw.item as Record<string, unknown> | undefined;
        const rawStatus = String(rawItem?.status ?? raw.status ?? '');
        const isDeclined = rawStatus === 'declined';
        this._forwardEvent(serverSessionId, {
          type: 'event',
          payload: {
            clientEventId: `error:${serverSessionId}:${Date.now()}`,
            sessionId: serverSessionId,
            agent: 'codex',
            eventType: 'error',
            data: {
              type: 'error',
              message: isDeclined
                ? '此操作需要 Codex 审批，当前手机端暂不支持 Codex 审批闭环'
                : `Codex tool failed: ${event.toolName}`,
              toolName: event.toolName,
              status: event.toolStatus,
            },
            ts: new Date().toISOString(),
          },
        });
      }
    }

    // 2. Append a final error if the process didn't complete successfully
    if (result.timedOut) {
      this._forwardEvent(serverSessionId, {
        type: 'event',
        payload: {
          clientEventId: `error:${serverSessionId}:${Date.now()}`,
          sessionId: serverSessionId,
          agent: 'codex',
          eventType: 'error',
          data: { type: 'error', message: 'Codex resume timed out' },
          ts: new Date().toISOString(),
        },
      });
    } else if (!result.success) {
      this._forwardEvent(serverSessionId, {
        type: 'event',
        payload: {
          clientEventId: `error:${serverSessionId}:${Date.now()}`,
          sessionId: serverSessionId,
          agent: 'codex',
          eventType: 'error',
          data: { type: 'error', message: result.stderr || 'Codex resume failed', exitCode: result.exitCode },
          ts: new Date().toISOString(),
        },
      });
    }
  }

  /**
   * Stop a resumed session: clean up runtime, watcher, relay registration.
   */
  async stopResume(localSessionId: string): Promise<void> {
    const serverSessionId = this.localToServer.get(localSessionId);
    if (!serverSessionId) return;

    const state = this.sessions.get(serverSessionId);
    if (state) {
      state.runtime.clearQueue();
      this.sessions.delete(serverSessionId);
    }

    this.localToServer.delete(localSessionId);
    this.resumedServerSessionIds.delete(serverSessionId);
    this.approvalBridge?.removeCodexAttachedSession(localSessionId);

    // Notify relay
    this.relay.sendRaw(JSON.stringify({
      type: 'deactivate_session',
      payload: { sessionId: serverSessionId },
    }));

    this._savePersistedIds();

    console.error('[codex-resume] stopped: local=%s server=%s', localSessionId, serverSessionId);
  }

  /** Push last 10 transcript messages to relay so phone shows same history as sidebar. */
  private async _forwardRecentHistory(serverSessionId: string, transcriptPath: string): Promise<void> {
    try {
      const { existsSync, readFileSync } = await import('node:fs');
      if (!existsSync(transcriptPath)) return;
      const text = readFileSync(transcriptPath, 'utf8');
      const lines = text.split('\n').filter(Boolean);

      const messages: { type: string; text: string; ts: string }[] = [];
      // Scan newest-first for user/assistant messages (same as loadCodexConversation)
      for (let i = lines.length - 1; i >= 0 && messages.length < 10; i--) {
        try {
          const obj = JSON.parse(lines[i]);
          let role = '';
          let content: unknown;
          if (obj.type === 'response_item' && obj.payload?.type === 'message') {
            role = obj.payload?.role as string | undefined || '';
            content = obj.payload.content;
          } else if (obj.type === 'event_msg' && obj.payload?.type === 'user_message') {
            role = 'user';
            content = obj.payload.message;
          } else if (obj.type === 'event_msg' && obj.payload?.type === 'agent_message') {
            role = 'assistant';
            content = obj.payload.message;
          } else {
            continue;
          }
          if (role !== 'user' && role !== 'assistant') continue;
          let extracted = '';
          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part === 'object' && (part.type === 'input_text' || part.type === 'text' || part.type === 'output_text') && part.text) {
                extracted += String(part.text) + ' ';
              }
            }
          } else if (typeof content === 'string') { extracted = content; }
          const trimmed = cleanCodexDisplayText(extracted);
          if (!trimmed) continue;
          const eventType = role === 'user' ? 'user_prompt' : 'task_complete';
          messages.push({ type: eventType, text: trimmed.slice(0, 500), ts: obj.timestamp || '' });
        } catch { /* skip */ }
      }
      // Forward in chronological order
      for (const msg of messages.reverse()) {
        this._forwardEvent(serverSessionId, {
          type: 'event',
          payload: {
            clientEventId: `history:${serverSessionId}:${Date.now()}:${Math.random().toString(36).slice(2, 6)}`,
            sessionId: serverSessionId,
            agent: 'codex',
            eventType: msg.type,
            data: msg.type === 'user_prompt'
              ? { type: 'user_prompt', prompt: msg.text, summary: msg.text.slice(0, 200) }
              : { type: 'task_complete', summary: msg.text.slice(0, 200), output: msg.text },
            ts: msg.ts || new Date().toISOString(),
          },
        });
      }
    } catch { /* best-effort */ }
  }

  /** Save resumed local session IDs to a JSON file so state survives bridge restart. */
  private _savePersistedIds(): void {
    if (!this.storagePath) return;
    import('node:fs').then(({ mkdirSync, writeFileSync }) => {
      import('node:path').then(({ dirname }) => {
        try {
          const ids = Array.from(this.localToServer.keys());
          mkdirSync(dirname(this.storagePath!), { recursive: true });
          writeFileSync(this.storagePath!, JSON.stringify({ resumedIds: ids }, null, 2), 'utf8');
        } catch (err) {
          console.error('[codex-resume] failed to persist resumed IDs:', err);
        }
      });
    }).catch(() => {});
  }

  /** Load previously resumed session IDs from storage and re-resume them. */
  private async _loadPersistedIds(): Promise<void> {
    if (!this.storagePath) return;
    try {
      const { existsSync, readFileSync } = await import('node:fs');
      if (!existsSync(this.storagePath)) return;
      const data = JSON.parse(readFileSync(this.storagePath, 'utf8'));
      const ids: string[] = data.resumedIds ?? [];
      if (ids.length === 0) return;

      console.error('[codex-resume] restoring %d persisted sessions', ids.length);
      for (const localId of ids) {
        const sessions = discoverLocalSessions(50);
        const session = sessions.find(s => s.sessionId === localId);
        if (session) {
          this.startResume(session).catch((err) => {
            console.error('[codex-resume] failed to restore session %s: %s', localId, err);
          });
        } else {
          console.error('[codex-resume] persisted session %s not found on disk, skipping', localId);
        }
      }
    } catch (err) {
      console.error('[codex-resume] failed to load persisted IDs:', err);
    }
  }

  /**
   * Stop all resumed sessions.
   */
  async stopAll(): Promise<void> {
    const ids = Array.from(this.localToServer.keys());
    await Promise.allSettled(ids.map((id) => this.stopResume(id)));
  }

  /**
   * Get active resumed sessions info (for UI polling).
   */
  /** Return local session IDs for all active (resumed) sessions. */
  getResumedLocalIds(): string[] {
    return Array.from(this.localToServer.keys());
  }

  getActiveSessions(): Array<{ localSession: CodexLocalSession; serverSessionId: string }> {
    const result: Array<{ localSession: CodexLocalSession; serverSessionId: string }> = [];
    for (const [serverSessionId, state] of this.sessions) {
      result.push({ localSession: state.localSession, serverSessionId });
    }
    return result;
  }

  /** Backfill historical transcript messages to relay so the phone sees past conversation. */
    /**
   * Register session on relay, return serverSessionId.
   * Matches the existing register_session protocol used by ApprovalBridge.
   */
  private _registerOnRelay(localSession: CodexLocalSession): Promise<string> {
    const clientRequestId = randomUUID();
    const windowId = process.env.CODEKEY_WINDOW_ID || undefined;

    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingClientRequests.delete(clientRequestId);
        reject(new Error('Session registration timeout'));
      }, 10_000);

      this.pendingClientRequests.set(clientRequestId, (sid: string) => {
        clearTimeout(timer);
        resolve(sid);
      });

      const metadata: Record<string, unknown> = {
        claudeSessionId: localSession.sessionId,
        title: localSession.title,
        cwd: localSession.cwd,
        source: 'resume',
        transcriptPath: localSession.transcriptPath,
        runtime: 'codex-resume',
      };

      const payload: Record<string, unknown> = {
        agentType: 'codex',
        claudeSessionId: localSession.sessionId,
        clientRequestId,
        metadata,
        sessionLabel: localSession.title,
      };
      if (windowId) payload.windowId = windowId;

      this.relay.sendRaw(JSON.stringify({
        type: 'register_session',
        payload,
      }));
    });
  }

  /**
   * Send an event to relay for a session.
   * Uses RelayClient.sendEvent which sends pre-serialized.
   */
  private _forwardEvent(serverSessionId: string, msg: Record<string, unknown>): void {
    this.relay.sendRaw(JSON.stringify(msg));
  }
}

interface ResumeSessionState {
  localSession: CodexLocalSession;
  runtime: CodexResumeRuntime;
}
