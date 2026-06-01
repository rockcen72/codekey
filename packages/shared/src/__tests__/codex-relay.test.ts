import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexRelay } from '../bridge/codex-relay.js';

interface MockRelayClient {
  on: ReturnType<typeof vi.fn>;
  sendRaw: ReturnType<typeof vi.fn>;
}

function createMockRelay(): MockRelayClient {
  return {
    on: vi.fn(),
    sendRaw: vi.fn(),
  };
}

/** Parse all sendRaw JSON messages, optionally filtered by type. */
function sentMessages(relay: MockRelayClient, type?: string): Record<string, unknown>[] {
  const msgs = relay.sendRaw.mock.calls
    .map((args: unknown[]) => JSON.parse(args[0] as string));
  return type ? msgs.filter(m => m.type === type) : msgs;
}

/** Find the handler registered for a given event. */
function findHandler(relay: MockRelayClient, event: string): ((payload: unknown) => void) | undefined {
  const entry = relay.on.mock.calls.find((args: unknown[]) => args[0] === event);
  return entry ? entry[1] as (payload: unknown) => void : undefined;
}

/** Simulate session_registered by finding the right handler and calling it. */
function simulateSessionRegistered(relay: MockRelayClient): void {
  const regMsgs = sentMessages(relay, 'register_session');
  const uid = regMsgs[0]?.payload as Record<string, unknown>;
  const handler = findHandler(relay, 'session_registered');
  expect(handler).toBeDefined();
  handler!({ claudeSessionId: uid?.claudeSessionId, sessionId: 'server-sess-123' });
}

/** Simulate approval_forward from relay. */
function simulateApprovalForward(relay: MockRelayClient, eventId: string, clientEventId: string, decision: string): void {
  const handler = findHandler(relay, 'approval_forward');
  expect(handler).toBeDefined();
  handler!({ eventId, clientEventId, decision });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CodexRelay', () => {
  let relay: MockRelayClient;
  let codexRelay: CodexRelay;

  beforeEach(() => {
    relay = createMockRelay();
    codexRelay = new CodexRelay(relay as any);
  });

  it('registers session on first approval', () => {
    codexRelay.registerApproval('req-1', 'some command', 'high');

    const reg = sentMessages(relay, 'register_session');
    expect(reg.length).toBe(1);
    expect((reg[0].payload as any).agentType).toBe('codex');
    expect((reg[0].payload as any).claudeSessionId).toMatch(/^codex-/);
  });

  it('buffers approvals before session_registered and flushes after', () => {
    codexRelay.registerApproval('req-1', 'cmd-a', 'low');
    codexRelay.registerApproval('req-2', 'cmd-b', 'high');

    // Before session_registered: no event messages
    expect(sentMessages(relay, 'event').length).toBe(0);

    // Simulate session_registered
    simulateSessionRegistered(relay);

    // After flush: 2 approval events
    expect(sentMessages(relay, 'event').length).toBe(2);
  });

  it('pushes approval immediately when session already registered', () => {
    codexRelay.registerApproval('req-0', 'init', 'low');
    simulateSessionRegistered(relay);

    // Clear mocks so we can see only the second registration's calls
    relay.sendRaw.mockClear();

    codexRelay.registerApproval('req-2', 'deploy', 'critical');
    const events = sentMessages(relay, 'event');
    expect(events.length).toBe(1);
    expect((events[0].payload as any).clientEventId).toBe('req-2');
    expect((events[0].payload as any).sessionId).toBe('server-sess-123');
  });

  it('maps approval_forward by clientEventId correctly', () => {
    codexRelay.registerApproval('ck-req-1', 'test cmd', 'medium');
    simulateSessionRegistered(relay);

    simulateApprovalForward(relay, 'server-event-999', 'ck-req-1', 'approve');

    const decisions = codexRelay.pollDecisions();
    expect(decisions.length).toBe(1);
    // Must return the original correlationId, not the server eventId
    expect(decisions[0].correlationId).toBe('ck-req-1');
    expect(decisions[0].decision).toBe('approve');
  });

  it('returns decisions only once (poll is destructive)', () => {
    codexRelay.registerApproval('req-1', 'cmd', 'low');
    simulateSessionRegistered(relay);
    simulateApprovalForward(relay, 'e1', 'req-1', 'approve');

    expect(codexRelay.pollDecisions().length).toBe(1);
    expect(codexRelay.pollDecisions().length).toBe(0);
  });
});
