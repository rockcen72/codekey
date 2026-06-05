import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexRelay } from '../bridge/codex-relay.js';

interface MockRelayClient {
  on: ReturnType<typeof vi.fn>;
  sendRaw: ReturnType<typeof vi.fn>;
}

function createMockRelay(): MockRelayClient {
  return { on: vi.fn(), sendRaw: vi.fn() };
}

function sentMessages(relay: MockRelayClient, type?: string): Record<string, unknown>[] {
  const msgs = relay.sendRaw.mock.calls
    .map((args: unknown[]) => JSON.parse(args[0] as string));
  return type ? msgs.filter(m => m.type === type) : msgs;
}

function findHandler(relay: MockRelayClient, event: string): ((payload: unknown) => void) | undefined {
  const entry = relay.on.mock.calls.find((args: unknown[]) => args[0] === event);
  return entry ? entry[1] as (payload: unknown) => void : undefined;
}

function simulateSessionRegistered(relay: MockRelayClient): void {
  const regMsgs = sentMessages(relay, 'register_session');
  const uid = regMsgs[0]?.payload as Record<string, unknown>;
  const handler = findHandler(relay, 'session_registered');
  expect(handler).toBeDefined();
  handler!({ claudeSessionId: uid?.claudeSessionId, sessionId: 'server-sess-123' });
}

function simulateApprovalForward(
  relay: MockRelayClient,
  eventId: string,
  clientEventId: string,
  decision: string,
  message = '',
): void {
  const handler = findHandler(relay, 'approval_forward');
  expect(handler).toBeDefined();
  handler!({ eventId, clientEventId, decision, message });
}

beforeEach(() => { vi.clearAllMocks(); });

describe('CodexRelay', () => {
  let relay: MockRelayClient;
  let codexRelay: CodexRelay;

  beforeEach(() => {
    relay = createMockRelay();
    codexRelay = new CodexRelay(relay as any);
  });

  // ── Approval tests ──

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
    expect(sentMessages(relay, 'event').length).toBe(0);
    simulateSessionRegistered(relay);
    expect(sentMessages(relay, 'event').length).toBe(2);
  });

  it('pushes approval immediately when session already registered', () => {
    codexRelay.registerApproval('req-0', 'init', 'low');
    simulateSessionRegistered(relay);
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
    const d = codexRelay.pollDecisions();
    expect(d[0].correlationId).toBe('ck-req-1');
    expect(d[0].decision).toBe('approve');
  });

  it('keeps reply message from approval_forward decisions', () => {
    codexRelay.registerApproval('input-1', 'choose agent', 'medium');
    simulateSessionRegistered(relay);
    simulateApprovalForward(relay, 'server-event-999', 'input-1', 'reply', 'general');
    expect(codexRelay.pollDecisions()[0]).toEqual({
      correlationId: 'input-1',
      decision: 'reply',
      message: 'general',
    });
  });

  it('returns decisions only once (poll is destructive)', () => {
    codexRelay.registerApproval('req-1', 'cmd', 'low');
    simulateSessionRegistered(relay);
    simulateApprovalForward(relay, 'e1', 'req-1', 'approve');
    expect(codexRelay.pollDecisions().length).toBe(1);
    expect(codexRelay.pollDecisions().length).toBe(0);
  });

  // ── Session / prompt tests ──

  it('ensureSession registers without waiting for approval', () => {
    codexRelay.ensureSession();
    const reg = sentMessages(relay, 'register_session');
    expect(reg.length).toBe(1);
  });

  it('ensureSession includes window metadata for sidebar filtering', () => {
    codexRelay.ensureSession({ windowId: 'window-1', title: 'Codex: abc12345', cwd: '/repo' });
    const reg = sentMessages(relay, 'register_session');
    const payload = reg[0].payload as any;
    expect(payload.metadata.windowId).toBe('window-1');
    expect(payload.metadata.title).toBe('Codex: abc12345');
    expect(payload.metadata.cwd).toBe('/repo');
  });

  it('pushEvent sends event under the registered session', () => {
    codexRelay.ensureSession();
    simulateSessionRegistered(relay);
    codexRelay.pushEvent('task_complete', { summary: 'done' });
    const ev = sentMessages(relay, 'event');
    expect((ev[0].payload as any).eventType).toBe('task_complete');
    expect((ev[0].payload as any).sessionId).toBe('server-sess-123');
  });

  it('uses input_required requestId as clientEventId for reply correlation', () => {
    codexRelay.ensureSession();
    simulateSessionRegistered(relay);
    codexRelay.pushEvent('input_required', { type: 'input_required', requestId: 'input-1', summary: 'Pick one' });
    const ev = sentMessages(relay, 'event');
    expect((ev[0].payload as any).clientEventId).toBe('input-1');
  });

  it('relay command queues prompts when sessionId matches', () => {
    codexRelay.ensureSession();
    simulateSessionRegistered(relay);
    const h = findHandler(relay, 'command')!;
    h({ sessionId: 'server-sess-123', action: 'write_stdin', data: 'hello codex' });
    expect(codexRelay.pollPrompts()).toEqual(['hello codex']);
  });

  it('relay command ignores non-matching sessionId', () => {
    codexRelay.ensureSession();
    simulateSessionRegistered(relay);
    const h = findHandler(relay, 'command')!;
    h({ sessionId: 'other', action: 'write_stdin', data: 'ignored' });
    expect(codexRelay.pollPrompts().length).toBe(0);
  });

  it('pollPrompts is destructive (one read only)', () => {
    codexRelay.ensureSession();
    simulateSessionRegistered(relay);
    const h = findHandler(relay, 'command')!;
    h({ sessionId: 'server-sess-123', action: 'write_stdin', data: 'twice' });
    expect(codexRelay.pollPrompts().length).toBe(1);
    expect(codexRelay.pollPrompts().length).toBe(0);
  });
});
