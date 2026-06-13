import { createServer, get as httpGet, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApprovalBridge, type HookEventBody } from './handler.js';
import { CodexRelay } from './codex-relay.js';
import { CodexResumeManager } from './codex-resume-manager.js';
import { discoverLocalSessions, normalizeCodexSessionTitle } from './codex-local-session-resolver.js';
import { type OpenCodeSessionManager } from './opencode-session-manager.js';
import { listRecentClaudeTranscripts, loadConversation } from './claude-transcripts.js';
import {
  HistorySharePolicy,
  type PolicyKey,
  type HistoryPolicyConfig,
  getConfig,
  getAllConfigs,
  setConfig,
  deleteConfig,
  DEFAULT_RECENT_COUNT,
} from './history-policy.js';

export interface BridgeConfig {
  deviceId: string;
  deviceToken?: string;
  /** Device secret for pairing WS auth (loaded from credentials file) */
  deviceSecret?: string;
  relayUrl: string;
  /** Path to admin panel directory (serves index.html at /) */
  adminDir?: string;
  /** OpenCode local server URL (default http://127.0.0.1:4096) */
  openCodeUrl?: string;
}

interface CodexHookResponse {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest';
    decision: { behavior: string; message?: string };
  };
}

function relayIsConnected(relay: unknown): boolean {
  return (relay as { status?: string })?.status === 'connected';
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576; // 1 MB

/**
 * CORS allowlist for the bridge HTTP server. The bridge only binds
 * 127.0.0.1, so this is defense-in-depth — we narrow Access-Control-Allow-Origin
 * from `*` to a strict prefix list. Anything not on the list gets `null`,
 * which browsers treat as "denied for CORS purposes".
 */
const ALLOWED_BRIDGE_ORIGIN_PREFIXES = [
  'vscode-webview://',   // VS Code webview host
  'http://127.0.0.1:',    // bridge URL (loopback)
  'http://localhost:',    // bridge URL (loopback)
];

function bridgeCorsOrigin(req: IncomingMessage): string {
  const origin = req.headers.origin;
  if (!origin) return 'null';
  for (const prefix of ALLOWED_BRIDGE_ORIGIN_PREFIXES) {
    if (origin.startsWith(prefix)) return origin;
  }
  return 'null';
}

/**
 * Read and parse a JSON request body, rejecting if the payload exceeds
 * `maxBytes` (default 1 MB). On overflow, writes a 413 response and destroys
 * the request socket. Resolves with the parsed JSON; rejects on overflow,
 * invalid JSON, or stream error. Caller is responsible for handling the
 * 400 response on non-overlow rejections.
 */
function readJsonBody(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = DEFAULT_MAX_BODY_BYTES,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let received = 0;
    req.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > maxBytes) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'payload too large' }));
        req.destroy();
        reject(new Error('payload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

export function startBridgeServer(bridge: ApprovalBridge, port = 3001, source = 'cli', onShutdown?: () => void, startedAt?: number, bridgeConfig?: BridgeConfig, codexResumeManager?: CodexResumeManager, opencodeManager?: OpenCodeSessionManager): Promise<{ close: () => Promise<void>; port: number }> {
  let mpOnline = false;
  let mpPlatform = 'wechat';
  bridge.relay.on('mp_online', (platform?: string) => { mpOnline = true; mpPlatform = platform || 'wechat'; });
  bridge.relay.on('mp_offline', (platform?: string) => { mpOnline = false; });
  const codexRelay = new CodexRelay(bridge.relay, bridge.auditSink);
  const pendingCodexHookRequests = new Map<string, Promise<CodexHookResponse>>();
  const server = createServer((req, res) => handleRequest(req, res, bridge, source, onShutdown, startedAt, bridgeConfig, codexRelay, codexResumeManager, opencodeManager, pendingCodexHookRequests, () => mpOnline));

  return new Promise((resolve, reject) => {
    const onListen = () => {
      const addr = server.address() as AddressInfo;
      console.error(`BRIDGE_PORT=${addr.port}`);
      console.error(`bridge server listening on http://127.0.0.1:${addr.port}`);
      resolve({
        port: addr.port,
        close: () => new Promise<void>((res) => server.close(() => res())),
      });
    };

    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`bridge port ${port} in use, trying auto-assign...`);
        server.listen(0, '127.0.0.1');
      } else {
        reject(err);
      }
    });

    server.listen(port, '127.0.0.1', onListen);
  });
}

function codexHookDedupKey(input: Record<string, unknown>): string {
  const sessionId = typeof input.session_id === 'string' ? input.session_id : 'unknown';
  const turnId = typeof input.turn_id === 'string' ? input.turn_id : '';
  const toolName = typeof input.tool_name === 'string' ? input.tool_name : 'unknown';
  return stableStringify({
    sessionId,
    turnId,
    toolName,
    toolInput: input.tool_input ?? null,
    cwd: input.cwd ?? '',
  });
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
}

function handleRequest(req: IncomingMessage, res: ServerResponse, bridge: ApprovalBridge, source: string, onShutdown?: () => void, startedAt?: number, bridgeConfig?: BridgeConfig, codexRelay?: CodexRelay, codexResumeManager?: CodexResumeManager, opencodeManager?: OpenCodeSessionManager, pendingCodexHookRequests?: Map<string, Promise<CodexHookResponse>>, getMpOnline?: () => boolean): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', bridgeCorsOrigin(req));
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/hook/approval') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const input = body;
        bridge.handleApproval(input).then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/hook-event') {
    console.error('[bridge] /v1/hook-event received');
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const input: HookEventBody = body;
        console.error('[bridge] /v1/hook-event: eventType=%s claudeSessionId=%s', input.eventType, input.claudeSessionId?.slice(0, 8) ?? '(none)');
        bridge.handleHookEvent(input).catch((err: unknown) => {
          console.error('[bridge] hook event error:', err);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        console.error('[bridge] /v1/hook-event try-catch err: %s', (err as Error).message);
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      console.error('[bridge] /v1/hook-event readJsonBody err: %s', err.message);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/pending-commands') {
    const commands = bridge.commandQueue.peek();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(commands));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/codex/approval') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { correlationId, command, risk } = body;
        if (correlationId && codexRelay) codexRelay.registerApproval(correlationId, command || '', risk || 'medium');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/codex/decisions') {
    const decisions = codexRelay ? codexRelay.pollDecisions() : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ decisions }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/codex/session/ensure') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      let metadata: Record<string, string> = {};
      try {
        if (body.trim()) {
          const input = body;
          metadata = {
            ...(typeof input.windowId === 'string' && input.windowId ? { windowId: input.windowId } : {}),
            ...(typeof input.title === 'string' && input.title ? { title: input.title } : {}),
            ...(typeof input.cwd === 'string' && input.cwd ? { cwd: input.cwd } : {}),
          };
        }
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid payload' }));
    return;
  }
      const p = codexRelay ? codexRelay.ensureSession(metadata) : Promise.resolve();
      p.then(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }).catch(() => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'session_register_failed' }));
      });
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/codex/event') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { eventType, data } = body;
        if (eventType && codexRelay) codexRelay.pushEvent(eventType, data || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/codex/prompts') {
    const prompts = codexRelay ? codexRelay.pollPrompts() : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ prompts }));
    return;
  }

  // ── Codex Resume sessions (Phase 2) ───────────────────────
  if (req.method === 'GET' && url.pathname === '/v1/codex-sessions' && codexResumeManager) {
    const cwd = url.searchParams.get('cwd') || undefined;
    const sessions = codexResumeManager.discoverSessions(10, cwd);
    // Dedup by sessionId
    const seen = new Set<string>();
    const deduped = sessions.filter(s => {
      if (seen.has(s.sessionId)) return false;
      seen.add(s.sessionId);
      return true;
    });
    const active = codexResumeManager.getActiveSessions();
    const activeById = new Map(active.map(a => [a.localSession.sessionId, a.serverSessionId]));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      sessions: deduped.map(s => ({
        ...s,
        resumed: activeById.has(s.sessionId),
      })),
    }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/codex-sessions/resume' && codexResumeManager) {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { sessionId, cwd } = body;
        // Scan broadly to find the exact session by ID, regardless of sort order
        const sessions = codexResumeManager.discoverSessions(50, cwd || undefined);
        const session = sessions.find(s => s.sessionId === sessionId);
        if (!session) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'session not found' }));
          return;
        }
        codexResumeManager.startResume(session).then((serverSessionId) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, serverSessionId }));
        }).catch((err: Error) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/codex-sessions/stop' && codexResumeManager) {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { sessionId, serverSessionId } = body;
        codexResumeManager.stopResume(sessionId, serverSessionId).then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }).catch((err: Error) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/codex-sessions/active' && codexResumeManager) {
    const active = codexResumeManager.getActiveSessions();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, sessions: active }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/codex-sessions/resumed-ids' && codexResumeManager) {
    const ids = codexResumeManager.getResumedLocalIds();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, ids }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/codex-sessions/server-id' && codexResumeManager) {
    const localId = url.searchParams.get('localId');
    if (!localId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'localId required' }));
      return;
    }
    const active = codexResumeManager.getActiveSessions();
    const session = active.find(a => a.localSession.sessionId === localId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'session not active' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, serverSessionId: session.serverSessionId }));
    return;
  }

  // ── Codex Hooks endpoints (Phase H1) ──────────────────────
  // POST /v1/codex-hooks/permission-request
  // Hook script calls this to relay a PermissionRequest and wait for phone decision.
  // Body: { session_id, cwd, tool_name, tool_input, ... } (from Codex hook stdin)
  // Returns: { hookSpecificOutput: { hookEventName, decision: { behavior, message? } } }
  if (req.method === 'POST' && url.pathname === '/v1/codex-hooks/permission-request') {
    readJsonBody(req, res).then(async (rawBody) => {
      const body = rawBody as any;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let regTimer: ReturnType<typeof setTimeout> | null = null;
      let regHandler: ((p: unknown) => void) | null = null;
      let handler: ((p: unknown) => void) | null = null;
      let ackCleanup: (() => void) | null = null;
      let clearLocalPending: (() => void) | null = null;
      let resolved = false;
      let dedupKey = '';
      let currentDedupPromise: Promise<CodexHookResponse> | null = null;
      let resolveDedup: ((value: CodexHookResponse) => void) | null = null;
      const acceptedEventIds = new Set<string>();

      function finish(behavior: string, message?: string) {
        if (resolved) return;
        resolved = true;
        if (timeout) clearTimeout(timeout);
        if (handler) { bridge.relay.off('approval_forward', handler as (...args: unknown[]) => void); handler = null; }
        if (ackCleanup) { ackCleanup(); ackCleanup = null; }
        if (regTimer) { clearTimeout(regTimer); regTimer = null; }
        if (regHandler) { bridge.relay.off('session_registered', regHandler); regHandler = null; }
        if (clearLocalPending) { clearLocalPending(); clearLocalPending = null; }
        const output: CodexHookResponse = {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior, ...(message ? { message } : {}) },
          },
        };
        if (dedupKey && pendingCodexHookRequests?.get(dedupKey) === currentDedupPromise) {
          pendingCodexHookRequests.delete(dedupKey);
        }
        resolveDedup?.(output);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(output));
      }

      try {
        const input = body;
        const codexSessionId = input.session_id || 'unknown';
        const toolName = input.tool_name || 'unknown';
        const toolInput = input.tool_input || {};
        const cmd = toolInput.command || toolInput.description || JSON.stringify(toolInput);

        if (!relayIsConnected(bridge.relay)) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, bypass: true, reason: 'relay_not_connected' }));
          return;
        }

        // Step 1: Resolve Codex local session id → relay serverSessionId.
        // If VS Code has a CodexResumeManager and this session is not resumed,
        // CodeKey should not handle the hook. Returning bypass lets the hook
        // script exit without output so Codex shows its own default approval UI.
        let serverSessionId: string | null = null;
        if (codexResumeManager) {
          const active = codexResumeManager.getActiveSessions();
          const found = active.find(a => a.localSession.sessionId === codexSessionId);
          if (found) {
            serverSessionId = found.serverSessionId;
            const label = normalizeCodexSessionTitle(found.localSession.title);
            if (label) {
              bridge.relay.sendRaw(JSON.stringify({
                type: 'update_session_label',
                payload: { sessionId: serverSessionId, label },
              }));
            }
          }
          if (!serverSessionId) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, bypass: true, reason: 'codex_session_not_resumed' }));
            return;
          }
        }

        dedupKey = codexHookDedupKey(input);
        const existing = dedupKey ? pendingCodexHookRequests?.get(dedupKey) : undefined;
        if (existing) {
          const output = await existing;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(output));
          return;
        }
        if (dedupKey && pendingCodexHookRequests) {
          currentDedupPromise = new Promise<CodexHookResponse>((resolve) => {
            resolveDedup = resolve;
          });
          pendingCodexHookRequests.set(dedupKey, currentDedupPromise);
        }

        // Step 2: Register on relay if not already active
        if (!serverSessionId) {
          const regClientRequestId = randomUUID();
          const localSession = discoverLocalSessions(50, input.cwd || undefined)
            .find(s => s.sessionId === codexSessionId);
          const sessionTitle = normalizeCodexSessionTitle(localSession?.title) || 'Codex Session';

          // Wrap registration in a promise with timeout
          const regResult = await new Promise<string | null>((resolve) => {
            const regTimeoutMs = parseInt(process.env.CODEX_HOOK_REG_TIMEOUT_MS || '5000', 10);
            regTimer = setTimeout(() => {
              console.error('[codex-hooks] session registration timed out for %s', codexSessionId);
              if (regHandler) bridge.relay.off('session_registered', regHandler);
              regTimer = null;
              resolve(null);
            }, regTimeoutMs);

            regHandler = (p: unknown) => {
              const reg = p as { clientRequestId?: string; sessionId: string };
              if (reg.clientRequestId === regClientRequestId) {
                if (regTimer) clearTimeout(regTimer);
                regTimer = null;
                bridge.relay.off('session_registered', regHandler as (...args: unknown[]) => void);
                regHandler = null;
                resolve(reg.sessionId);
              }
            };
            bridge.relay.on('session_registered', regHandler);

            bridge.relay.sendRaw(JSON.stringify({
              type: 'register_session',
              payload: {
                agentType: 'codex',
                claudeSessionId: codexSessionId,
                clientRequestId: regClientRequestId,
                metadata: {
                  claudeSessionId: codexSessionId,
                  title: sessionTitle,
                  source: 'codex_hook',
                  runtime: 'codex-hooks',
                  cwd: input.cwd || '',
                  hookEventName: 'PermissionRequest',
                },
                sessionLabel: sessionTitle,
              },
            }));
          });

          if (!regResult) {
            finish('deny', 'CodeKey session registration timed out');
            return;
          }
          serverSessionId = regResult;
        }

        // Step 3: Register approval_forward handler BEFORE sending event (avoid race)
        // Use randomUUID to avoid collision when concurrent hooks fire for the same session.
        const clientEventId = `hook:${codexSessionId}:${randomUUID()}`;
        acceptedEventIds.add(clientEventId);
        ackCleanup = bridge.onEventAck((ackedClientEventId, serverEventId) => {
          if (ackedClientEventId === clientEventId) {
            acceptedEventIds.add(serverEventId);
          }
        });

        const approvalTimeoutMs = parseInt(process.env.CODEX_HOOK_APPROVAL_TIMEOUT_MS || '300000', 10);
        timeout = setTimeout(() => {
          console.error('[codex-hooks] timeout: session=%s tool=%s', codexSessionId, toolName);
          finish('deny', 'Phone approval timed out');
        }, approvalTimeoutMs);

        handler = (payload: unknown) => {
          const fwd = payload as { clientEventId?: string; eventId?: string; decision?: string; message?: string };
          if (!(fwd.clientEventId && acceptedEventIds.has(fwd.clientEventId)) && !(fwd.eventId && acceptedEventIds.has(fwd.eventId))) return;
          const approved = fwd.decision === 'approve';
          console.error('[codex-hooks] decision: session=%s tool=%s decision=%s', codexSessionId, toolName, fwd.decision);
          finish(approved ? 'allow' : 'deny', fwd.message);
        };
        bridge.relay.on('approval_forward', handler);

        // Step 4: Send approval event to relay (phone shows approval card)
        const command = typeof cmd === 'string' ? cmd.slice(0, 1000) : JSON.stringify(cmd).slice(0, 1000);
        const summary = `Codex needs approval: ${toolName}`;
        clearLocalPending = bridge.trackPendingApproval({
          id: clientEventId,
          serverSessionId,
          claudeSessionId: codexSessionId,
          agentType: 'codex',
          command,
          summary,
          toolName,
          risk: 'medium',
        });
        const codexPayload = JSON.stringify({
          type: 'event',
          payload: {
            clientEventId,
            sessionId: serverSessionId,
            agent: 'codex',
            eventType: 'approval_required',
            data: {
              type: 'approval_required',
              tool_name: toolName,
              command,
              summary,
              risk: 'medium',
            },
            ts: new Date().toISOString(),
          },
        });
        bridge.privacyCheckAndSend('approval', codexPayload);

      } catch (err) {
        console.error('[codex-hooks] error:', err);
        finish('deny', 'Bridge error');
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  // ── OpenCode Telemetry ────────────────────────────────────
  // POST /v1/opencode/telemetry
  // OpenCode plugin sends events here for sidebar state display only.
  // No decision logic is derived from this data.
  if (req.method === 'POST' && url.pathname === '/v1/opencode/telemetry') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const input = body;
        // Route telemetry events through the SSE handler to forward to relay
        if (opencodeManager && input.type && input.properties) {
          opencodeManager.handleSSEEvent(input).catch((err) => {
            console.error('[bridge] opencode SSE event error:', err);
          });
        }
      } catch {
        // best-effort, don't fail
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  // ── OpenCode Sessions ──────────────────────────────────────
  // GET /v1/opencode-sessions
  // Proxies /session from the local OpenCode server (127.0.0.1:4096).
  // Falls back to an empty list when OpenCode is not running.
  if (req.method === 'GET' && url.pathname === '/v1/opencode-sessions') {
    if (opencodeManager) {
      opencodeManager.listSessions().then((sessions) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions }));
      }).catch(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions: [] }));
      });
      return;
    }
    const ocUrl = new URL('/session', bridgeConfig?.openCodeUrl || 'http://127.0.0.1:4096');
    console.error('[bridge] opencode-sessions: proxying to %s', ocUrl.href);
    const proxy = httpGet(
      { hostname: ocUrl.hostname, port: ocUrl.port, path: ocUrl.pathname, timeout: 3000 },
      (ocRes) => {
        let body = '';
        ocRes.on('data', (chunk: Buffer) => { body += chunk; });
        ocRes.on('end', () => {
          try {
            const sessions = ocRes.statusCode && ocRes.statusCode < 300 ? JSON.parse(body) as any[] : [];
            console.error('[bridge] opencode-sessions: got %d sessions', sessions.length);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, sessions }));
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, sessions: [] }));
          }
        });
      },
    );
    proxy.on('error', (err) => {
      console.error('[bridge] opencode-sessions: proxy failed — %s', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    });
    proxy.on('timeout', () => {
      console.error('[bridge] opencode-sessions: proxy timed out');
      proxy.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, sessions: [] }));
    });
    return;
  }

  // ── OpenCode session attach/detach ─────────────────────────
  if (req.method === 'POST' && url.pathname === '/v1/opencode-sessions/attach') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { sessionId, title, serverSessionId } = body;
        if (!sessionId) { res.writeHead(400); res.end('{}'); return; }
        // Respond immediately — relay registration + history push runs async
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));

        const fetchMessages = (sid: string) => {
          const ocUrl = new URL(`/session/${encodeURIComponent(sid)}/message?limit=${DEFAULT_RECENT_COUNT}`, bridgeConfig?.openCodeUrl || 'http://127.0.0.1:4096');
          return new Promise<any[]>((resolve) => {
            httpGet({ hostname: ocUrl.hostname, port: ocUrl.port, path: ocUrl.pathname + ocUrl.search, timeout: 5000 }, (ocRes) => {
              let body = '';
              ocRes.on('data', (chunk: Buffer) => { body += chunk; });
              ocRes.on('end', () => {
                try { resolve(ocRes.statusCode && ocRes.statusCode < 300 ? JSON.parse(body) : []); }
                catch { resolve([]); }
              });
            }).on('error', () => resolve([])).on('timeout', function(this: any) { this.destroy(); resolve([]); });
          });
        };
        const attach = opencodeManager
          ? opencodeManager.attachSession(
              sessionId,
              typeof title === 'string' ? title : undefined,
              typeof serverSessionId === 'string' ? serverSessionId : undefined,
            )
          : bridge.attachOpenCodeSession(
              sessionId,
              fetchMessages,
              typeof title === 'string' ? title : undefined,
              undefined,
              typeof serverSessionId === 'string' ? serverSessionId : undefined,
            );
        attach.catch((err: Error) => {
            console.error('[bridge] opencode-attach failed: %s', err.message);
          });
      } catch {
        res.writeHead(400);
        res.end('{}');
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/opencode-sessions/detach') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { sessionId, serverSessionId } = body;
        if (!sessionId) { res.writeHead(400); res.end('{}'); return; }
        const detach = opencodeManager
          ? opencodeManager.detachSession(sessionId, typeof serverSessionId === 'string' ? serverSessionId : undefined)
            : bridge.ensureSession(sessionId, undefined, 'opencode', { agentType: 'opencode', runtime: 'opencode' }).then((serverSessionId) => {
              bridge.removeOpenCodeAttachedSession(sessionId);
              bridge.relay.sendRaw(JSON.stringify({ type: 'deactivate_session', payload: { sessionId: serverSessionId, reason: 'manual_detach' } }));
              return false;
            });
        detach.then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        }).catch(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  // ── OpenCode session preview ────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/v1/opencode-sessions/preview') {
    const sid = url.searchParams.get('id') || '';
    if (!sid) { res.writeHead(400); res.end('{}'); return; }
    const ocUrl = new URL(`/session/${encodeURIComponent(sid)}/message?limit=${DEFAULT_RECENT_COUNT}`, bridgeConfig?.openCodeUrl || 'http://127.0.0.1:4096');
    console.error('[bridge] opencode-preview: proxying to %s', ocUrl.href);
    const proxy = httpGet(
      { hostname: ocUrl.hostname, port: ocUrl.port, path: ocUrl.pathname + ocUrl.search, timeout: 5000 },
      (ocRes) => {
        let body = '';
        ocRes.on('data', (chunk: Buffer) => { body += chunk; });
        ocRes.on('end', () => {
          try {
            const msgs = ocRes.statusCode && ocRes.statusCode < 300 ? JSON.parse(body) : [];
            // Transform OpenCode messages to { role, text, timestamp } format
            const entries = (Array.isArray(msgs) ? msgs : []).map((m: any, i: number) => {
              const info = m.info || {};
              const role = info.role === 'assistant' ? 'assistant' : 'user';
              // Extract text from parts
              let text = '';
              if (Array.isArray(m.parts)) {
                text = m.parts
                  .filter((p: any) => p.type === 'text' && p.text)
                  .map((p: any) => p.text)
                  .join('\n');
              }
              return { role, text: text.slice(0, 1000), timestamp: info.time?.created ? new Date(info.time.created).toISOString() : '', index: i };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, entries }));
          } catch {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, entries: [] }));
          }
        });
      },
    );
    proxy.on('error', (err) => {
      console.error('[bridge] opencode-preview: proxy failed — %s', err.message);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: [] }));
    });
    proxy.on('timeout', () => {
      proxy.destroy();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: [] }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/pending-approvals') {
    const approvals = bridge.getPendingApprovals();
    // Merge Codex pending entries that aren't in the bridge's list
    // (Codex uses a separate event path and doesn't register in
    // pendingByServerEventId).
    if (codexRelay) {
      const codexPending = codexRelay.getPendingApprovals();
      const bridgeIds = new Set(approvals.map(a => a.serverEventId));
      for (const cp of codexPending) {
        if (bridgeIds.has(cp.id)) continue;
        approvals.push({
          id: cp.id,
          serverEventId: cp.id,
          serverSessionId: codexRelay._sessionId() ?? '',
          claudeSessionId: codexRelay._codexSessionUid() ?? '',
          agentType: 'codex',
          command: cp.command,
          summary: cp.command,
          toolName: 'Codex',
          risk: cp.risk as any,
          createdAt: cp.createdAt,
        });
      }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ approvals }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/approval-response') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const input = body;
        const sessionId = typeof input.sessionId === 'string' ? input.sessionId : '';
        const eventId = typeof input.eventId === 'string' ? input.eventId : '';
        const clientEventId = typeof input.clientEventId === 'string' ? input.clientEventId : '';
        const decision = typeof input.decision === 'string' ? input.decision : '';
        const message = typeof input.message === 'string' ? input.message : '';
        if (!sessionId || !eventId || !['approve', 'deny', 'pause', 'reply'].includes(decision)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid approval response' }));
          return;
        }
        bridge.relay.sendRaw(JSON.stringify({
          type: 'approval_response',
          payload: { sessionId, eventId, decision, message },
        }));
        // Local VS Code approval notifications should release an in-flight Codex
        // hook immediately. The relay will usually echo approval_forward back,
        // but waiting for that round trip makes desktop approvals fragile.
        bridge.relay.emit('approval_forward', {
          sessionId,
          eventId,
          decision,
          message,
          ...(clientEventId ? { clientEventId } : {}),
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/pending-commands/claim') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { ids } = body;
        if (!Array.isArray(ids)) throw new Error('ids must be an array');
        const claimed = bridge.commandQueue.claim(ids);
        // Record phone command fingerprints for transcript prompt dedup
        for (const cmd of claimed) {
          bridge.recordClaimedPhoneCommand(cmd.sessionId, cmd.text);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(claimed));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/register-window') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { windowId } = body;
        if (windowId) bridge.registerWindow(windowId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/session-label') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { windowId, label } = body;
        if (windowId && label && typeof label === 'string') {
          bridge.setPendingLabel(windowId, label);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  // Sync a tab label to the relay for a specific claudeSessionId (startup use).
  if (req.method === 'POST' && url.pathname === '/v1/sync-session-label') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { claudeSessionId, label } = body;
        if (claudeSessionId && label && typeof label === 'string') {
          bridge.syncSessionLabel(claudeSessionId, label);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/activate-session') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { windowId, sessionLabel, windowIdPrefix } = body;
        if (!windowId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'windowId required' }));
          return;
        }
        bridge.activateSession(windowId, sessionLabel ?? '', windowIdPrefix).then((sessionId) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, sessionId }));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/deactivate-session') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { windowId } = body;
        if (!windowId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'windowId required' }));
          return;
        }
        bridge.deactivateSession(windowId).then(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  // Fire-and-forget deactivate: sends WS message immediately, doesn't wait for ack.
  // Used by VS Code deactivate() which must return quickly.
  // Deactivates ALL sessions matching the windowId prefix (window-level + tab-level).
  if (req.method === 'POST' && url.pathname === '/v1/close-window') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { windowId } = body;
        if (windowId) {
          bridge.deactivateByWindow(windowId);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/claude-sessions/recent') {
    const limit = Number(url.searchParams.get('limit') || '20');
    listRecentClaudeTranscripts(limit)
      .then((sessions) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessions }));
      })
      .catch((err) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      });
    return;
  }

  if (req.method === 'GET') {
    const conversationMatch = url.pathname.match(/^\/v1\/claude-sessions\/([^/]+)\/conversation$/);
    if (conversationMatch) {
      const sessionId = conversationMatch[1];
      const maxEntries = Number(url.searchParams.get('max') || '50');
      try {
        const entries = loadConversation(sessionId, maxEntries);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, sessionId, entries }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: String(err) }));
      }
      return;
    }
  }

  if (req.method === 'POST' && url.pathname === '/v1/claude-sessions/attach') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { sessionId } = body;
        if (!sessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'sessionId required' }));
          return;
        }
        bridge.attachClaudeSession(sessionId).then((serverSessionId) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, serverSessionId }));
        }).catch((err: Error) => {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/detach-session') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { claudeSessionId } = body;
        if (!claudeSessionId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'claudeSessionId required' }));
          return;
        }
        bridge.detachClaudeSession(claudeSessionId).then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/active-sessions') {
    const active = bridge.getActiveSessionIds();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, active }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/attached-sessions') {
    const attached = bridge.getAttachedSessionIds();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, attached }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/relay-reconnect') {
    bridge.relay.reconnect();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/shutdown') {
    if (!onShutdown) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'no shutdown callback registered' }));
      return;
    }
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { windowId } = body;
        if (windowId) bridge.deactivateByWindow(windowId);

        // Check remaining windows with 60s TTL: stale windows (crashed VS Code)
        // don't block shutdown.
        const STALE_WINDOW_MS = 60_000;
        const now = Date.now();
        let activeCount = 0;
        for (const [, lastSeen] of bridge.getActiveWindows()) {
          if (now - lastSeen < STALE_WINDOW_MS) activeCount++;
        }
        if (activeCount > 0) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'other windows still active', activeCount }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        onShutdown();
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  // ── Admin panel: serve config ──
  if (req.method === 'GET' && url.pathname === '/v1/admin-config' && bridgeConfig) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      relayUrl: bridgeConfig.relayUrl,
      deviceId: bridgeConfig.deviceId,
      deviceToken: bridgeConfig.deviceToken ?? null,
      deviceSecret: bridgeConfig.deviceSecret ?? null,
      hasToken: !!bridgeConfig.deviceToken,
      relayStatus: bridge.relay.status,
      source,
    }));
    return;
  }

  // ── Admin panel: serve static files ──
  if (req.method === 'GET' && bridgeConfig?.adminDir && (url.pathname === '/' || url.pathname === '/index.html')) {
    const indexPath = resolve(bridgeConfig.adminDir, 'index.html');
    try {
      const html = readFileSync(indexPath, 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    } catch {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'admin panel not found' }));
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/session-error') {
    readJsonBody(req, res).then((input) => {
      const { sessionId, agent, message } = input as { sessionId?: string; agent?: string; message?: string };
      if (!sessionId || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'sessionId and message required' }));
          return;
        }
        bridge.sendErrorToRelay(sessionId, message, agent || undefined);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
    }).catch((err) => {
      if (err.message !== 'payload too large') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    });
    return;
  }

  // ── History Share Policy (Phase 2) ──────────────────────
  // GET /v1/history-policy?key=sessionId
  // Returns the current history policy config for a given key.
  if (req.method === 'GET' && url.pathname === '/v1/history-policy') {
    const key = (url.searchParams.get('key') || '*') as PolicyKey;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getConfig(key)));
    return;
  }

  // GET /v1/history-policies
  // Returns ALL configured history policy configs.
  if (req.method === 'GET' && url.pathname === '/v1/history-policies') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getAllConfigs()));
    return;
  }

  // PUT /v1/history-policy
  // Sets history policy config for a given key.
  if (req.method === 'PUT' && url.pathname === '/v1/history-policy') {
    readJsonBody(req, res).then((rawBody) => {
      const body = rawBody as any;
      try {
        const { key, config } = body;
        if (!key || !config || typeof config.policy !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'key and config.policy required' }));
          return;
        }
        if (!Object.values(HistorySharePolicy).includes(config.policy)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'invalid policy value' }));
          return;
        }
        setConfig(key as PolicyKey, config as HistoryPolicyConfig);
        const normalizedConfig = getConfig(key as PolicyKey);
        bridge.relay.sendRaw(JSON.stringify({
          type: 'sync_history_policy',
          payload: { action: 'set', key, config: { ...normalizedConfig, updatedAt: normalizedConfig.updatedAt || Date.now() } },
        }));
        bridge.reevaluateClaudeSync();
        if (opencodeManager) {
          for (const localId of bridge.opencodeAttachedIds) {
            opencodeManager.replayAttachedHistory(localId);
          }
        }
        if (codexResumeManager) {
          codexResumeManager.replayActiveHistory();
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    }).catch((err: Error) => {
      if (err?.message === 'payload too large') return;
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
    });
    return;
  }

  // DELETE /v1/history-policy
  // Deletes history policy config for a given key.
  if (req.method === 'DELETE' && url.pathname === '/v1/history-policy') {
    const key = (url.searchParams.get('key') || '*') as PolicyKey;
    deleteConfig(key);
    bridge.relay.sendRaw(JSON.stringify({
      type: 'sync_history_policy',
      payload: { action: 'delete', key },
    }));
    bridge.reevaluateClaudeSync();
    if (opencodeManager) {
      for (const localId of bridge.opencodeAttachedIds) {
        opencodeManager.replayAttachedHistory(localId);
      }
    }
    if (codexResumeManager) {
      codexResumeManager.replayActiveHistory();
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/privacy-stats') {
    const stats = bridge.auditCollector.stats();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(stats));
    return;
  }

  if (url.pathname === '/v1/health') {
    const supports = ['mp-status', 'register-window', 'window-id', 'session-label', 'approval_forward', 'activate-session', 'deactivate-session', 'claude-sessions/recent', 'claude-sessions/attach', 'detach-session', 'attached-sessions', 'relay-reconnect', 'admin-config', 'pending-approvals', 'approval-response', 'codex-hooks/permission-request', 'session-error', 'privacy-stats'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      source,
      version: '0.1.0',
      relay: bridge.relay.status,
      mpOnline: getMpOnline?.() ?? false,
      supports,
      startedAt: startedAt ?? 0,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
