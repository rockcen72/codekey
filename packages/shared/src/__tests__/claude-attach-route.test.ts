import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { ApprovalBridge } from '../bridge/handler.js';
import { startBridgeServer } from '../bridge/server.js';

class FakeRelay extends EventEmitter {
  status = 'connected';
  sendRaw(_value: string): void { /* not used */ }
  sendEvent(_sessionId: string, _msg: unknown): void { /* not used */ }
  sendCheckedPayload(_payload: { raw: string }): void { /* not used */ }
}

describe('POST /v1/claude-sessions/attach', () => {
  it('accepts the attach request before background relay ack completes', async () => {
    const relay = new FakeRelay();
    const attachClaudeSession = vi.fn(() =>
      new Promise<string>((_resolve, reject) => {
        setTimeout(() => reject(new Error('late registration timeout')), 50);
      }),
    );
    const bridge = {
      relay,
      attachClaudeSession,
      auditSink: undefined,
    } as unknown as ApprovalBridge;

    const { port, close } = await startBridgeServer(bridge, 0, 'test');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/claude-sessions/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'claude-a' }),
      });
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body).toEqual({ ok: true });
      expect(attachClaudeSession).toHaveBeenCalledWith('claude-a');

      await new Promise((resolve) => setTimeout(resolve, 80));
    } finally {
      await close();
    }
  });
});
