import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ApprovalBridge, type HookEventBody } from './handler.js';
import { CodexRelay } from './codex-relay.js';
import { listRecentClaudeTranscripts, loadConversation } from './claude-transcripts.js';

export interface BridgeConfig {
  deviceId: string;
  deviceToken?: string;
  /** Device secret for pairing WS auth (loaded from credentials file) */
  deviceSecret?: string;
  relayUrl: string;
  /** Path to admin panel directory (serves index.html at /) */
  adminDir?: string;
}

export function startBridgeServer(bridge: ApprovalBridge, port = 3001, source = 'cli', onShutdown?: () => void, startedAt?: number, bridgeConfig?: BridgeConfig): Promise<{ close: () => Promise<void>; port: number }> {
  const codexRelay = new CodexRelay(bridge.relay);
  const server = createServer((req, res) => handleRequest(req, res, bridge, source, onShutdown, startedAt, bridgeConfig, codexRelay));

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

function handleRequest(req: IncomingMessage, res: ServerResponse, bridge: ApprovalBridge, source: string, onShutdown?: () => void, startedAt?: number, bridgeConfig?: BridgeConfig, codexRelay?: CodexRelay): void {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.method === 'POST' && url.pathname === '/v1/hook/approval') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const input = JSON.parse(body);
        bridge.handleApproval(input).then((result) => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        });
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/hook-event') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const input: HookEventBody = JSON.parse(body);
        bridge.handleHookEvent(input).catch((err: unknown) => {
          console.error('[bridge] hook event error:', err);
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'invalid payload' }));
      }
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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { correlationId, command, risk } = JSON.parse(body);
        if (correlationId && codexRelay) codexRelay.registerApproval(correlationId, command || '', risk || 'medium');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid payload' }));
      }
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
    if (codexRelay) codexRelay.ensureSession();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/codex/event') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { eventType, data } = JSON.parse(body);
        if (eventType && codexRelay) codexRelay.pushEvent(eventType, data || {});
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid payload' }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/codex/prompts') {
    const prompts = codexRelay ? codexRelay.pollPrompts() : [];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ prompts }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/v1/pending-approvals') {
    const approvals = bridge.getPendingApprovals();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ approvals }));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/pending-commands/claim') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { ids } = JSON.parse(body);
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
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/register-window') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { windowId } = JSON.parse(body);
        if (windowId) bridge.registerWindow(windowId);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/session-label') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { windowId, label } = JSON.parse(body);
        if (windowId && label && typeof label === 'string') {
          bridge.setPendingLabel(windowId, label);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  // Sync a tab label to the relay for a specific claudeSessionId (startup use).
  if (req.method === 'POST' && url.pathname === '/v1/sync-session-label') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { claudeSessionId, label } = JSON.parse(body);
        if (claudeSessionId && label && typeof label === 'string') {
          bridge.syncSessionLabel(claudeSessionId, label);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/activate-session') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { windowId, sessionLabel, windowIdPrefix } = JSON.parse(body);
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
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/deactivate-session') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { windowId } = JSON.parse(body);
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
    });
    return;
  }

  // Fire-and-forget deactivate: sends WS message immediately, doesn't wait for ack.
  // Used by VS Code deactivate() which must return quickly.
  // Deactivates ALL sessions matching the windowId prefix (window-level + tab-level).
  if (req.method === 'POST' && url.pathname === '/v1/close-window') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { windowId } = JSON.parse(body);
        if (windowId) {
          bridge.deactivateByWindow(windowId);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false }));
      }
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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { sessionId } = JSON.parse(body);
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
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/v1/detach-session') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { claudeSessionId } = JSON.parse(body);
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
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        const { windowId } = JSON.parse(body);
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

  if (url.pathname === '/v1/health') {
    const supports = ['register-window', 'window-id', 'session-label', 'approval_forward', 'activate-session', 'deactivate-session', 'claude-sessions/recent', 'claude-sessions/attach', 'detach-session', 'attached-sessions', 'relay-reconnect', 'admin-config', 'pending-approvals'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      source,
      version: '0.1.0',
      relay: bridge.relay.status,
      supports,
      startedAt: startedAt ?? 0,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
