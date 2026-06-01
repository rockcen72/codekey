import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexRelay } from '../bridge/codex-relay.js';

interface MockRelayClient {
  on: ReturnType<typeof vi.fn>;
  sendRaw: ReturnType<typeof vi.fn>;
}

function createMockRelay(): MockRelayClient {
  const handlers = new Map<string, (payload: unknown) => void>();
  return {
    on: vi.fn((event: string, handler: (payload: unknown) => void) => {
      handlers.set(event, handler);
    }),
    sendRaw: vi.fn(),
  };
}

describe('CodexRelay', () => {
  let relay: MockRelayClient;
  let codexRelay: CodexRelay;

  beforeEach(() => {
    relay = createMockRelay();
    codexRelay = new CodexRelay(relay as any);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('registers session on first approval and pushes event', () => {
    codexRelay.registerApproval('req-1', 'rm -rf /tmp', 'high');

    // First call should register a session
    expect(relay.sendRaw).toHaveBeenCalled();
    const calls = relay.sendRaw.mock.calls.map((c: [string]) => JSON.parse(c[0]));

    // First message should be register_session
    const registerMsg = calls.find((c: any) => c.type === 'register_session');
    expect(registerMsg).toBeDefined();
    expect(registerMsg.payload.agentType).toBe('codex');
    expect(registerMsg.payload.claudeSessionId).toMatch(/^codex-/);
  });

  it('buffers approvals before session_registered and flushes after', () => {
    codexRelay.registerApproval('req-1', 'cmd-a', 'low');
    codexRelay.registerApproval('req-2', 'cmd-b', 'high');

    // Get the register_session call to extract claudeSessionId
    const registerCall = relay.sendRaw.mock.calls.find((c: [string]) =>
      JSON.parse(c[0]).type === 'register_session'
    );
    const uid = JSON.parse(registerCall[0]).payload.claudeSessionId;

    // Before session_registered, there should be NO event for approval_required
    const approvalEventsBefore = relay.sendRaw.mock.calls.filter((c: [string]) =>
      JSON.parse(c[0]).type === 'event'
    );
    expect(approvalEventsBefore.length).toBe(0);

    // Simulate session_registered
    const registeredHandler = relay.on.mock.calls.find((c: [string]) => c[0] === 'session_registered');
    expect(registeredHandler).toBeDefined();
    const handler = registeredHandler[1];
    handler({ claudeSessionId: uid, sessionId: 'server-session-123' });

    // After flush, there should be 2 approval events
    const approvalEventsAfter = relay.sendRaw.mock.calls.filter((c: [string]) =>
      JSON.parse(c[0]).type === 'event'
    );
    expect(approvalEventsAfter.length).toBe(2);
  });

  it('pushes approval immediately when session already registered', () => {
    // Trigger session registration with first call
    codexRelay.registerApproval('req-0', 'init', 'low');

    // Find the handler and trigger session_registered
    const regHandler = relay.on.mock.calls.find((c: [string]) => c[0] === 'session_registered')[1];
    const regCall = relay.sendRaw.mock.calls.find((c: [string]) =>
      JSON.parse(c[0]).type === 'register_session'
    );
    regHandler({ claudeSessionId: JSON.parse(regCall[0]).payload.claudeSessionId, sessionId: 'real-sess' });

    // Clear mocks to reset call count
    relay.sendRaw.mockClear();

    // Now register a second approval — should push immediately
    codexRelay.registerApproval('req-2', 'deploy', 'critical');
    const events = relay.sendRaw.mock.calls
      .map((c: [string]) => JSON.parse(c[0]))
      .filter((m: any) => m.type === 'event');
    expect(events.length).toBe(1);
    expect(events[0].payload.clientEventId).toBe('req-2');
    expect(events[0].payload.sessionId).toBe('real-sess');
  });

  it('maps approval_forward by clientEventId correctly', () => {
    // Register, then simulate session ready
    codexRelay.registerApproval('ck-req-1', 'test cmd', 'medium');
    const regHandler = relay.on.mock.calls.find((c: [string]) => c[0] === 'session_registered')[1];
    const regCall = relay.sendRaw.mock.calls.find((c: [string]) =>
      JSON.parse(c[0]).type === 'register_session'
    );
    regHandler({ claudeSessionId: JSON.parse(regCall[0]).payload.claudeSessionId, sessionId: 'sess-1' });

    // Find the approval_forward listener
    const fwdHandler = relay.on.mock.calls.find((c: [string]) => c[0] === 'approval_forward')[1];

    // Simulate approval_forward with clientEventId matching our correlationId
    fwdHandler({
      eventId: 'server-event-999',
      clientEventId: 'ck-req-1',
      decision: 'approve',
    });

    const decisions = codexRelay.pollDecisions();
    expect(decisions.length).toBe(1);
    // Must return the original correlationId, not the server eventId
    expect(decisions[0].correlationId).toBe('ck-req-1');
    expect(decisions[0].decision).toBe('approve');
  });

  it('returns decisions only once (poll is destructive)', () => {
    codexRelay.registerApproval('req-1', 'cmd', 'low');
    const regHandler = relay.on.mock.calls.find((c: [string]) => c[0] === 'session_registered')[1];
    const regCall = relay.sendRaw.mock.calls.find((c: [string]) =>
      JSON.parse(c[0]).type === 'register_session'
    );
    regHandler({ claudeSessionId: JSON.parse(regCall[0]).payload.claudeSessionId, sessionId: 's-1' });

    const fwdHandler = relay.on.mock.calls.find((c: [string]) => c[0] === 'approval_forward')[1];
    fwdHandler({ eventId: 'e1', clientEventId: 'req-1', decision: 'approve' });

    expect(codexRelay.pollDecisions().length).toBe(1);
    expect(codexRelay.pollDecisions().length).toBe(0);
  });
});
