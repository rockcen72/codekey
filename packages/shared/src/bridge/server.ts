import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { ApprovalBridge, type HookEventBody } from './handler.js';
import { listRecentClaudeTranscripts } from './claude-transcripts.js';

export function startBridgeServer(bridge: ApprovalBridge, port = 3001, source = 'cli', onShutdown?: () => void): Promise<() => void> {
  const server = createServer((req, res) => handleRequest(req, res, bridge, source, onShutdown));

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      console.error(`bridge server listening on http://127.0.0.1:${addr.port}`);
      resolve(() => server.close());
    });
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, bridge: ApprovalBridge, source: string, onShutdown?: () => void): void {
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

  if (url.pathname === '/v1/health') {
    const supports = ['register-window', 'window-id', 'session-label', 'approval_forward', 'activate-session', 'deactivate-session', 'claude-sessions/recent', 'claude-sessions/attach', 'detach-session', 'attached-sessions', 'relay-reconnect'];
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      source,
      version: '0.1.0',
      relay: bridge.relay.status,
      supports,
    }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
