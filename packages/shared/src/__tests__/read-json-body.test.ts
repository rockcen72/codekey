import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { ApprovalBridge } from '../bridge/handler.js';
import { startBridgeServer } from '../bridge/server.js';

/**
 * Body-size limit (1 MB) and JSON parsing tests for the bridge server.
 *
 * The readJsonBody helper is internal to server.ts, so we test it through
 * the public HTTP surface. A FakeRelay (EventEmitter) stands in for
 * RelayClient so we don't open real WebSocket connections.
 */

class FakeRelay extends EventEmitter {
  sendRaw(_value: string): void { /* not used by these endpoints */ }
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

describe('readJsonBody / body size limit', () => {
  it('rejects 413 when body exceeds 1MB', async () => {
    const { port, close } = await startServer();
    try {
      // Build a body just over 1 MB
      const big = Buffer.from('{"x":"' + 'a'.repeat(1_100_000) + '"}', 'utf-8');
      expect(big.length).toBeGreaterThan(1_048_576);
      const r = await fetch(`http://127.0.0.1:${port}/v1/hook/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: big,
      });
      expect(r.status).toBe(413);
      const text = await r.text();
      expect(JSON.parse(text)).toEqual({ ok: false, error: 'payload too large' });
    } finally {
      await close();
    }
  }, 10_000);

  it('accepts a body just under 1MB', async () => {
    const { port, close } = await startServer();
    try {
      // {"x":"aaaa..."} → ~10 chars of overhead + N padding 'a's
      const target = 1_048_500;
      const padding = 'a'.repeat(target - 10);
      const body = Buffer.from('{"x":"' + padding + '"}', 'utf-8');
      expect(body.length).toBeLessThanOrEqual(1_048_576);
      const r = await fetch(`http://127.0.0.1:${port}/v1/hook/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
      });
      // Body is valid JSON but handler may return 200/400 based on shape.
      // Critical: must NOT be 413.
      expect(r.status).not.toBe(413);
    } finally {
      await close();
    }
  }, 10_000);

  it('returns 400 for invalid JSON under the size limit', async () => {
    const { port, close } = await startServer();
    try {
      const r = await fetch(`http://127.0.0.1:${port}/v1/hook/approval`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{not valid json',
      });
      expect(r.status).toBe(400);
    } finally {
      await close();
    }
  }, 10_000);
});
