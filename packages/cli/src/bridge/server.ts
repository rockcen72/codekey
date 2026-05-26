import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { type AddressInfo } from 'node:net';
import { ApprovalBridge, type HookEventBody } from './handler.js';

export function startBridgeServer(bridge: ApprovalBridge, port = 3001): Promise<() => void> {
  const server = createServer((req, res) => handleRequest(req, res, bridge));

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      console.error(`bridge server listening on http://127.0.0.1:${addr.port}`);
      resolve(() => server.close());
    });
  });
}

function handleRequest(req: IncomingMessage, res: ServerResponse, bridge: ApprovalBridge): void {
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
        bridge.handleHookEvent(input);
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(claimed));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid payload' }));
      }
    });
    return;
  }

  if (url.pathname === '/v1/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'not found' }));
}
