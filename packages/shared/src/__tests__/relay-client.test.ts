import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RelayClient } from '../bridge/relay-client.js';

describe('RelayClient pending buffer TTL', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('drops pending messages older than 5 minutes on flushPending', () => {
    const client = new RelayClient('dev-1', 'token-abc', 'wss://relay.example');
    (client as any).ws = null;

    client.sendRaw('{"id":"old-1"}');
    client.sendRaw('{"id":"old-2"}');

    vi.advanceTimersByTime(6 * 60 * 1000);

    const sent: string[] = [];
    (client as any).ws = { readyState: 1, send: (s: string) => sent.push(s) };

    (client as any).flushPending();

    expect(sent).toEqual([]);
  });

  it('keeps fresh messages while dropping old ones', () => {
    const client = new RelayClient('dev-1', 'token-abc', 'wss://relay.example');
    (client as any).ws = null;

    client.sendRaw('{"id":"old"}');
    vi.advanceTimersByTime(4 * 60 * 1000);
    client.sendRaw('{"id":"new"}');
    vi.advanceTimersByTime(2 * 60 * 1000);

    const sent: string[] = [];
    (client as any).ws = { readyState: 1, send: (s: string) => sent.push(s) };
    (client as any).flushPending();

    expect(sent).toEqual(['{"id":"new"}']);
  });

  it('caps queue at 100 entries after TTL eviction', () => {
    const client = new RelayClient('dev-1', 'token-abc', 'wss://relay.example');
    (client as any).ws = null;

    for (let i = 0; i < 150; i++) {
      client.sendRaw(`{"id":"${i}"}`);
    }

    const pending = (client as any).pendingRaw as unknown[];
    expect(pending.length).toBe(100);
  });

  it('evicts on new enqueue (not only on flush)', () => {
    const client = new RelayClient('dev-1', 'token-abc', 'wss://relay.example');
    (client as any).ws = null;

    client.sendRaw('{"id":"stale"}');
    vi.advanceTimersByTime(6 * 60 * 1000);
    client.sendRaw('{"id":"fresh"}');

    const pending = (client as any).pendingRaw as { data: string; ts: number }[];
    expect(pending.length).toBe(1);
    expect(pending[0].data).toBe('{"id":"fresh"}');
  });
});
