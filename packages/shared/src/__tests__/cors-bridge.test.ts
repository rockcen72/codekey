import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { ApprovalBridge } from '../bridge/handler.js';
import { startBridgeServer } from '../bridge/server.js';

class FakeRelay extends EventEmitter {
  sendRaw(_value: string): void { /* not used */ }
  sendEvent(_sessionId: string, _msg: unknown): void { /* not used */ }
}

function createBridge() {
  const relay = new FakeRelay();
  return new ApprovalBridge(relay as any);
}

async function startServer() {
  const bridge = createBridge();
  return startBridgeServer(bridge, 0, 'test');
}

describe('B2-3 CORS allowlist', () => {
  it('returns matching origin for vscode-webview://', async () => {
    const { port, close } = await startServer();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/pending-commands`, {
        headers: { origin: 'vscode-webview://abcdef' },
      });
      expect(r.headers.get('access-control-allow-origin')).toBe('vscode-webview://abcdef');
    } finally { await close(); }
  }, 10_000);

  it('returns matching origin for 127.0.0.1 loopback', async () => {
    const { port, close } = await startServer();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/pending-commands`, {
        headers: { origin: 'http://127.0.0.1:8080' },
      });
      expect(r.headers.get('access-control-allow-origin')).toBe('http://127.0.0.1:8080');
    } finally { await close(); }
  }, 10_000);

  it('returns null for disallowed origin', async () => {
    const { port, close } = await startServer();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/pending-commands`, {
        headers: { origin: 'https://evil.example.com' },
      });
      expect(r.headers.get('access-control-allow-origin')).toBe('null');
    } finally { await close(); }
  }, 10_000);

  it('responds 204 to OPTIONS preflight', async () => {
    const { port, close } = await startServer();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/claude-sessions/attach`, {
        method: 'OPTIONS',
        headers: {
          origin: 'vscode-webview://x',
          'access-control-request-method': 'POST',
        },
      });
      expect(r.status).toBe(204);
      expect(r.headers.get('access-control-allow-origin')).toBe('vscode-webview://x');
      expect(r.headers.get('access-control-allow-methods')).toMatch(/POST/);
    } finally { await close(); }
  }, 10_000);
});
