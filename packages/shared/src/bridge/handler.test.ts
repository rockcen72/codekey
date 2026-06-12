import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApprovalBridge } from './handler.js';
import { OpenCodeSessionManager } from './opencode-session-manager.js';

/** Create a temp CLAUDE_CONFIG_DIR with a transcript for the given sessionId.
 *  Returns the temp dir path. Caller must set process.env.CLAUDE_CONFIG_DIR. */
function createTranscriptFixture(sessionId: string, title: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ck-test-'));
  const projectDir = join(tmpDir, 'projects', 'test-project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`),
    JSON.stringify({ type: 'user', message: { role: 'user', content: title } }) + '\n',
  );
  return tmpDir;
}

function appendTranscriptLine(tmpDir: string, sessionId: string, line: unknown): void {
  appendFileSync(join(tmpDir, 'projects', 'test-project', `${sessionId}.jsonl`), JSON.stringify(line) + '\n');
}

function cleanupOpenCodeAttachedStorage(): void {
  const path = join(tmpdir(), 'codekey-opencode-attached.json');
  if (existsSync(path)) rmSync(path);
}

function createCodexSessionFixture(sessionId: string): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ck-codex-test-'));
  const sessionDir = join(tmpDir, 'sessions', '2026', '06', '01');
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, `rollout-2026-06-01T00-00-00-${sessionId}.jsonl`),
    JSON.stringify({
      type: 'session_meta',
      payload: { id: sessionId, cwd: 'F:\\Work\\Codekey', source: 'vscode' },
    }) + '\n',
  );
  return tmpDir;
}

class FakeRelay extends EventEmitter {
  sent: string[] = [];
  attachedSessions: { id: string; claudeSessionId: string | null }[] = [];
  status = 'connected';

  sendRaw(value: string): void {
    this.sent.push(value);
    const msg = JSON.parse(value);
    if (msg.type === 'register_session') {
      queueMicrotask(() => {
        this.emit('session_registered', {
          clientRequestId: msg.payload.clientRequestId,
          sessionId: `server-${msg.payload.claudeSessionId}`,
          claudeSessionId: msg.payload.claudeSessionId,
        });
      });
    }
    if (msg.type === 'query_attached_sessions') {
      queueMicrotask(() => {
        this.emit('attached_sessions', { sessions: this.attachedSessions });
      });
    }
    if (msg.type === 'attach_session') {
      queueMicrotask(() => {
        this.emit('session_registered', {
          sessionId: msg.payload.sessionId,
          claudeSessionId: msg.payload.claudeSessionId,
        });
      });
    }
  }

  sendEvent(_sessionId: string, msg: unknown): void {
    this.sent.push(JSON.stringify(msg));
  }

  sendCheckedPayload(payload: { raw: string }): void {
    this.sendRaw(payload.raw);
  }
}

describe('ApprovalBridge canonical sessions', () => {
  it('registers different claudeSessionIds as different server sessions even in the same VS Code window', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const a = await bridge.ensureSession('claude-a', 'window-1');
    const b = await bridge.ensureSession('claude-b', 'window-1');

    expect(a).toBe('server-claude-a');
    expect(b).toBe('server-claude-b');
    expect(a).not.toBe(b);
  });

  it('returns same server session for same claudeSessionId', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const a = await bridge.ensureSession('claude-a');
    const b = await bridge.ensureSession('claude-a');

    expect(a).toBe(b);
  });

  it('registers sessions independently of windowId', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Same claudeSessionId should get same server session regardless of windowId
    const a = await bridge.ensureSession('claude-a', 'window-1');
    const b = await bridge.ensureSession('claude-a', 'window-2');

    expect(a).toBe(b);
  });

  it('throws for empty claudeSessionId', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await expect(bridge.ensureSession('')).rejects.toThrow('claudeSessionId');
  });

  it('queues phone commands for non-primary sessions', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await bridge.ensureSession('claude-a');
    const sessionB = await bridge.ensureSession('claude-b');

    bridge.listenRelayCommands();
    relay.emit('command', { sessionId: sessionB, action: 'write_stdin', data: 'next step' });

    expect(bridge.commandQueue.peek()).toEqual([
      { id: expect.any(String), sessionId: sessionB, claudeSessionId: 'claude-b', text: 'next step' },
    ]);
  });

  it('registers OpenCode attach mappings so phone commands route to OpenCode', async () => {
    cleanupOpenCodeAttachedStorage();
    try {
      const relay = new FakeRelay();
      const bridge = new ApprovalBridge(relay as any);
      const manager = new OpenCodeSessionManager('http://127.0.0.1:1', bridge);

      await manager.attachSession('ses_local_a');

      expect(manager.ownsSession('server-ses_local_a')).toBe(true);
      expect(bridge.getAttachedSessionIds()).toContain('ses_local_a');
    } finally {
      cleanupOpenCodeAttachedStorage();
    }
  });

  it('skips command queue for resumed Codex server sessions', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Simulate CodexResumeManager registering a resumed session
    const resumedServerSessionIds = new Set<string>();
    bridge.registerResumedServerSessionIds(resumedServerSessionIds);

    const serverSessionA = await bridge.ensureSession('claude-a');

    // Mark session A as resumed (Codex-managed)
    resumedServerSessionIds.add(serverSessionA);

    bridge.listenRelayCommands();

    // Command for resumed session should NOT enter command queue
    relay.emit('command', { sessionId: serverSessionA, action: 'write_stdin', data: 'codex prompt' });
    expect(bridge.commandQueue.peek()).toEqual([]);

    // Command for non-resumed session should still enter command queue normally
    const sessionB = await bridge.ensureSession('claude-b');
    relay.emit('command', { sessionId: sessionB, action: 'write_stdin', data: 'claude prompt' });
    expect(bridge.commandQueue.peek()).toEqual([
      { id: expect.any(String), sessionId: sessionB, claudeSessionId: 'claude-b', text: 'claude prompt' },
    ]);
  });

  it('emits command_started when a phone command is claimed by desktop', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);
    const serverSession = await bridge.ensureSession('claude-a');

    bridge.listenRelayCommands();
    relay.emit('command', { sessionId: serverSession, action: 'write_stdin', data: 'phone prompt' });

    const [cmd] = bridge.commandQueue.peek();
    const claimed = bridge.commandQueue.claim([cmd.id]);
    for (const item of claimed) {
      bridge.recordClaimedPhoneCommand(item.sessionId, item.text);
    }

    const events = relay.sent
      .map(m => JSON.parse(m))
      .filter((m: any) => m.type === 'event');
    const started = events.find((m: any) => m.payload.eventType === 'command_started');

    expect(started).toBeDefined();
    expect(started.payload.sessionId).toBe(serverSession);
    expect(started.payload.data).toEqual({ type: 'command_started', command: 'phone prompt' });
    expect(events.some((m: any) => m.payload.eventType === 'task_complete')).toBe(false);
  });

  it('does not queue commands for known Codex local sessions that are not resumed', async () => {
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = createCodexSessionFixture('codex-local-a');
    try {
      const relay = new FakeRelay();
      const bridge = new ApprovalBridge(relay as any);
      const serverSession = await bridge.ensureSession('codex-local-a');

      bridge.listenRelayCommands();
      relay.emit('command', { sessionId: serverSession, action: 'write_stdin', data: 'phone prompt' });

      expect(bridge.commandQueue.peek()).toEqual([]);
      const errorEvents = relay.sent
        .map(m => JSON.parse(m))
        .filter((m: any) => m.type === 'event' && m.payload.eventType === 'error');
      expect(errorEvents).toHaveLength(1);
      expect(errorEvents[0].payload.agent).toBe('codex');
      expect(errorEvents[0].payload.data.message).toContain('Codex 会话尚未 Resume');
    } finally {
      if (previousCodexHome) process.env.CODEX_HOME = previousCodexHome;
      else delete process.env.CODEX_HOME;
    }
  });

  it('ignores hook events without windowId when the session is unknown', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await bridge.handleHookEvent({
      eventType: 'session_idle',
      claudeSessionId: 'external-claude-session',
      data: { type: 'session_idle', idleMinutes: 0 },
    });

    expect(relay.sent).toEqual([]);
  });

  it('tracks input_required hook events so phone replies resolve them', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await bridge.handleHookEvent({
      eventType: 'input_required',
      claudeSessionId: 'claude-input',
      codekeyWindowId: 'window-input',
      data: {
        id: 'select-agent',
        questions: [{
          id: 'agent',
          text: 'Choose an agent',
          options: ['builder', 'reviewer'],
        }],
      },
    });

    const inputEvent = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'event' && m.payload.eventType === 'input_required');
    expect(inputEvent).toBeDefined();
    expect(bridge.getPendingApprovals()).toEqual([
      expect.objectContaining({
        id: 'select-agent',
        serverSessionId: 'server-claude-input',
        agentType: 'claude-code-hook',
      }),
    ]);

    relay.emit('approval_forward', {
      eventId: 'select-agent',
      clientEventId: 'select-agent',
      decision: 'reply',
      message: 'builder',
    });

    expect(bridge.getPendingApprovals()).toEqual([]);
    expect(relay.sent.some((m) => m.includes('"resolve_event"') && m.includes('select-agent'))).toBe(true);
  });

  it('deduplicates identical approval hooks while the approval is pending', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);
    const body = {
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
      source: 'permission_request',
      rawEvent: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test', cwd: 'F:\\Work\\Codekey' },
      },
    };

    const first = bridge.handleApproval(body);
    const second = bridge.handleApproval(body);

    await new Promise(resolve => setImmediate(resolve));

    const eventMessages = relay.sent
      .map(m => JSON.parse(m))
      .filter((m: any) => m.type === 'event' && m.payload.eventType === 'approval_required');
    expect(eventMessages).toHaveLength(1);

    const clientEventId = eventMessages[0].payload.clientEventId;
    relay.emit('approval_forward', {
      eventId: clientEventId,
      clientEventId,
      decision: 'approve',
    });

    await expect(first).resolves.toEqual({ approved: true });
    await expect(second).resolves.toEqual({ approved: true });
  });

  it('clears a pending CC approval when phone approval_forward arrives before event_ack', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const approval = bridge.handleApproval({
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
      source: 'permission_request',
      rawEvent: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test', cwd: 'F:\\Work\\Codekey' },
      },
    });

    await new Promise(resolve => setImmediate(resolve));

    expect(bridge.getPendingApprovals()).toHaveLength(1);

    relay.emit('approval_forward', {
      eventId: 'server-event-1',
      decision: 'approve',
      sessionId: 'server-claude-a',
    });

    await expect(approval).resolves.toEqual({ approved: true });
    expect(bridge.getPendingApprovals()).toEqual([]);
  });

  it('auto-rejects handleApproval without source (replay guard)', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const result = await bridge.handleApproval({
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
      rawEvent: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      },
    });

    expect(result).toEqual({ approved: false });
    // No approval_required event should be sent to relay
    const eventMessages = relay.sent
      .map(m => JSON.parse(m))
      .filter((m: any) => m.type === 'event' && m.payload.eventType === 'approval_required');
    expect(eventMessages).toHaveLength(0);
  });

  it('bypasses handleApproval when relay is disconnected', async () => {
    const relay = new FakeRelay();
    relay.status = 'disconnected';
    const bridge = new ApprovalBridge(relay as any);

    const result = await bridge.handleApproval({
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
      source: 'permission_request',
      rawEvent: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      },
    });

    expect(result).toEqual({
      approved: false,
      bypass: true,
      reason: 'relay_not_connected',
    });
    expect(relay.sent).toEqual([]);
  });

  it('uses a label-synced window as fallback for approvals without hook window id', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    bridge.setPendingLabel('window-1', 'Active Claude tab');
    const promise = bridge.handleApproval({
      claudeSessionId: 'claude-a',
      source: 'permission_request',
      rawEvent: {
        tool_name: 'Bash',
        tool_input: { command: 'npm test' },
      },
    });

    await new Promise(resolve => setImmediate(resolve));
    const eventMessages = relay.sent
      .map(m => JSON.parse(m))
      .filter((m: any) => m.type === 'event' && m.payload.eventType === 'approval_required');
    expect(eventMessages[0].payload.windowId).toBe('window-1');
    expect(eventMessages[0].payload.sessionLabel).toBe('Active Claude tab');

    const clientEventId = eventMessages[0].payload.clientEventId;
    relay.emit('approval_forward', {
      eventId: clientEventId,
      clientEventId,
      decision: 'approve',
    });

    await expect(promise).resolves.toEqual({ approved: true });
  });

  it('includes readable approval text for non-Bash tool requests', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const approval = bridge.handleApproval({
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
      source: 'permission_request',
      rawEvent: {
        tool_name: 'Read',
        tool_input: { file_path: 'F:\\Work\\Codekey\\README.md' },
      },
    });

    await new Promise(resolve => setImmediate(resolve));

    const eventMessage = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'event' && m.payload.eventType === 'approval_required');
    expect(eventMessage.payload.data.command).toContain('Read');
    expect(eventMessage.payload.data.command).toContain('README.md');
    expect(eventMessage.payload.data.summary).not.toBe('');

    const clientEventId = eventMessage.payload.clientEventId;
    relay.emit('approval_forward', {
      eventId: clientEventId,
      clientEventId,
      decision: 'deny',
    });
    await approval;
  });

  it('includes approval text when tool input uses alternate field names', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const approval = bridge.handleApproval({
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
      source: 'permission_request',
      rawEvent: {
        tool_name: 'WebSearch',
        input: { query: 'New York weather' },
      },
    });

    await new Promise(resolve => setImmediate(resolve));

    const eventMessage = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'event' && m.payload.eventType === 'approval_required');
    expect(eventMessage.payload.data.command).toContain('WebSearch');
    expect(eventMessage.payload.data.command).toContain('New York weather');

    const clientEventId = eventMessage.payload.clientEventId;
    relay.emit('approval_forward', {
      eventId: clientEventId,
      clientEventId,
      decision: 'deny',
    });
    await approval;
  });

  it('hook-created sessions are not considered attached until attachClaudeSession runs', async () => {
    const tmpDir = createTranscriptFixture('claude-a', 'Real transcript title');
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      const relay = new FakeRelay();
      const bridge = new ApprovalBridge(relay as any);

      await bridge.ensureSession('claude-a', 'window-1');

      expect(bridge.getAttachedSessionIds()).toEqual([]);

      await bridge.attachClaudeSession('claude-a');

      expect(bridge.getAttachedSessionIds()).toContain('claude-a');
      const attachMsg = relay.sent
        .map(m => JSON.parse(m))
        .find((m: any) => m.type === 'attach_session');
      expect(attachMsg).toMatchObject({
        type: 'attach_session',
        payload: {
          sessionId: 'server-claude-a',
          claudeSessionId: 'claude-a',
        },
      });
      expect(attachMsg.payload.metadata.source).toBe('transcript_attach');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('detachClaudeSession sends deactivate_session to relay and clears local cache immediately', async () => {
    const tmpDir = createTranscriptFixture('claude-a', 'Real transcript title');
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Attach a session first
    await bridge.attachClaudeSession('claude-a');
    expect(relay.sent.length).toBeGreaterThan(0);

    // Detach — should send deactivate_session and clear local cache immediately.
    const beforeSentCount = relay.sent.length;
    const result = await bridge.detachClaudeSession('claude-a');

    expect(result).toEqual({ ok: true });
    // Should have sent one more message: deactivate_session
    expect(relay.sent.length).toBe(beforeSentCount + 1);
    const lastMsg = JSON.parse(relay.sent[relay.sent.length - 1]);
    expect(lastMsg.type).toBe('deactivate_session');
    expect(lastMsg.payload.sessionId).toBe('server-claude-a');
    expect(lastMsg.payload.reason).toBe('manual_detach');

    expect(bridge.getAttachedSessionIds()).not.toContain('claude-a');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('reattach after detach registers a fresh session before session_deactivated ack arrives', async () => {
    const tmpDir = createTranscriptFixture('claude-a', 'Real transcript title');
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      const relay = new FakeRelay();
      const bridge = new ApprovalBridge(relay as any);

      await bridge.attachClaudeSession('claude-a');
      await bridge.detachClaudeSession('claude-a');
      const beforeReattach = relay.sent.length;

      await bridge.attachClaudeSession('claude-a');

      const reattachMessages = relay.sent
        .slice(beforeReattach)
        .map((raw) => JSON.parse(raw));
      expect(reattachMessages.some((msg) => msg.type === 'register_session')).toBe(true);
      expect(reattachMessages.some((msg) => msg.type === 'attach_session')).toBe(false);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('session_deactivated event clears local session and attached caches', async () => {
    const tmpDir = createTranscriptFixture('claude-a', 'Real transcript title');
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await bridge.attachClaudeSession('claude-a');
    expect(bridge.getAttachedSessionIds()).toContain('claude-a');

    // Simulate relay confirming deactivation
    relay.emit('session_deactivated', { sessionId: 'server-claude-a' });

    expect(bridge.getAttachedSessionIds()).not.toContain('claude-a');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('session_deactivated event clears Codex and OpenCode attached ids (regression: cancel-sync kept button "synced")', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Codex: add with serverSessionId so the new localId→serverId map is populated
    bridge.addCodexAttachedSession('codex-local-1', 'server-codex-1');
    bridge.addCodexAttachedSession('codex-local-2', 'server-codex-2');

    // OpenCode: also tracked via this.sessions (set by attachOpenCodeSession /
    // ensureSession in production). The session_deactivated handler reads from
    // this.sessions to resolve localId → serverSessionId.
    (bridge as any)._opencodeAttachedIds.add('opencode-local-1');
    (bridge as any).sessions.set('opencode-local-1', 'server-opencode-1');
    (bridge as any)._opencodeAttachedIds.add('opencode-local-2');
    (bridge as any).sessions.set('opencode-local-2', 'server-opencode-2');

    // Sanity: all four show up as attached
    expect(bridge.getAttachedSessionIds().sort()).toEqual(
      ['codex-local-1', 'codex-local-2', 'opencode-local-1', 'opencode-local-2'].sort(),
    );

    // Deactivate one of each — only those should clear
    relay.emit('session_deactivated', { sessionId: 'server-codex-1' });
    relay.emit('session_deactivated', { sessionId: 'server-opencode-2' });

    expect(bridge.getAttachedSessionIds().sort()).toEqual(
      ['codex-local-2', 'opencode-local-1'].sort(),
    );
    // Internal Maps / Sets also clean
    expect((bridge as any)._codexAttachedIds.has('codex-local-1')).toBe(false);
    expect((bridge as any)._codexAttachedToServer.has('codex-local-1')).toBe(false);
    expect((bridge as any)._opencodeAttachedIds.has('opencode-local-2')).toBe(false);
    expect((bridge as any).sessions.has('opencode-local-2')).toBe(false);
  });

  it('reconcileAttachedSessions re-registers transcript sessions absent from relay response', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Set up pre-existing state: one stale session, one fresh session still on relay
    relay.attachedSessions = [
      { id: 'server-fresh', claudeSessionId: 'fresh-session' },
    ];
    (bridge as any).sessions.set('stale-session', 'server-stale');
    (bridge as any).sessions.set('fresh-session', 'server-fresh');
    (bridge as any).transcriptAttachedIds.add('stale-session');
    (bridge as any).transcriptAttachedIds.add('fresh-session');

    await bridge.reconcileAttachedSessions();

    // stale-session should be restored if the relay lost it during reconnect cleanup.
    expect(bridge.getAttachedSessionIds()).toContain('stale-session');
    expect(bridge.getAttachedSessionIds()).toContain('fresh-session');

    const ids = Array.from((bridge as any).transcriptAttachedIds);
    expect(ids).toEqual(expect.arrayContaining(['fresh-session', 'stale-session']));

    const registerMsg = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'register_session' && m.payload.claudeSessionId === 'stale-session');
    expect(registerMsg).toBeDefined();
  });

  it('reconcileAttachedSessions restores lost transcript sessions and backfills events', async () => {
    const tmpDir = createTranscriptFixture('lost-session', 'User prompt');
    appendTranscriptLine(tmpDir, 'lost-session', {
      type: 'assistant',
      timestamp: '2026-06-04T12:00:00Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'Recovered assistant reply' }] },
    });
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      const relay = new FakeRelay();
      const bridge = new ApprovalBridge(relay as any);

      (bridge as any).transcriptAttachedIds.add('lost-session');
      await bridge.reconcileAttachedSessions();
      await new Promise(resolve => setImmediate(resolve));

      expect(bridge.getAttachedSessionIds()).toContain('lost-session');
      const events = relay.sent
        .map(m => JSON.parse(m))
        .filter((m: any) => m.type === 'event');
      expect(events.some((m: any) => m.payload.eventType === 'user_prompt')).toBe(true);
      expect(events.some((m: any) =>
        m.payload.eventType === 'task_complete'
        && m.payload.data.summary === 'Recovered assistant reply',
      )).toBe(true);
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('_registerOnRelay uses tab label as metadata.title when windowLabels has matching entry', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Pre-set a label in windowLabels (as startTabLabelSync would do)
    (bridge as any).windowLabels.set('tab-window-1', 'Fix login bug');

    // Register via ensureSession with windowId (hook path)
    await bridge.ensureSession('claude-session-1', 'tab-window-1');

    // Find the register_session message
    const registerMsg = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'register_session');

    expect(registerMsg).toBeDefined();
    expect(registerMsg.payload.metadata.title).toBe('Fix login bug');
    expect(registerMsg.payload.sessionLabel).toBe('Fix login bug');
  });

  it('_registerOnRelay writes options.title into metadata.title when no windowLabel', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await bridge.ensureSession('opencode-session-1', undefined, 'opencode', {
      agentType: 'opencode',
      runtime: 'opencode',
      title: 'My OpenCode Task',
    });

    const registerMsg = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'register_session');

    expect(registerMsg).toBeDefined();
    expect(registerMsg.payload.metadata.title).toBe('My OpenCode Task');
    expect(registerMsg.payload.metadata.runtime).toBe('opencode');
    expect(registerMsg.payload.metadata.source).toBe('opencode');
  });

  it('_registerOnRelay omits metadata.title when no windowLabel, no options.title, no transcript title', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await bridge.ensureSession('claude-no-title', undefined, 'hook');

    const registerMsg = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'register_session');

    expect(registerMsg).toBeDefined();
    expect('title' in registerMsg.payload.metadata).toBe(false);
  });

  it('attachOpenCodeSession passes title into register_session metadata and does NOT send update_session_label', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);
    const fetchMessages = async () => [];

    await bridge.attachOpenCodeSession(
      'opencode-local-1',
      fetchMessages,
      'My OpenCode Task',
    );

    const sentTypes = relay.sent.map(m => JSON.parse(m).type);
    const registerMsg = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'register_session');

    expect(registerMsg).toBeDefined();
    expect(registerMsg.payload.metadata.title).toBe('My OpenCode Task');
    expect(registerMsg.payload.metadata.runtime).toBe('opencode');
    expect(registerMsg.payload.metadata.source).toBe('opencode');
    expect(sentTypes).not.toContain('update_session_label');
  });

  it('attachOpenCodeSession without title sends register without title and no update_session_label', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);
    const fetchMessages = async () => [];

    await bridge.attachOpenCodeSession('opencode-local-2', fetchMessages);

    const sentTypes = relay.sent.map(m => JSON.parse(m).type);
    const registerMsg = relay.sent
      .map(m => JSON.parse(m))
      .find((m: any) => m.type === 'register_session');

    expect(registerMsg).toBeDefined();
    expect('title' in registerMsg.payload.metadata).toBe(false);
    expect(sentTypes).not.toContain('update_session_label');
  });

  it('attachOpenCodeSession with knownServerSessionId + title sends attach_session AND update_session_label', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);
    const fetchMessages = async () => [];

    await bridge.attachOpenCodeSession(
      'opencode-local-3',
      fetchMessages,
      'Recovered Title',
      undefined,
      'server-existing-3',
    );

    const sent = relay.sent.map(m => JSON.parse(m));
    const sentTypes = sent.map(m => m.type);

    expect(sentTypes).toContain('attach_session');
    expect(sentTypes).toContain('update_session_label');
    expect(sentTypes).not.toContain('register_session');

    const attachMsg = sent.find(m => m.type === 'attach_session');
    expect(attachMsg.payload.sessionId).toBe('server-existing-3');

    const labelMsg = sent.find(m => m.type === 'update_session_label');
    expect(labelMsg.payload.sessionId).toBe('server-existing-3');
    expect(labelMsg.payload.label).toBe('Recovered Title');
  });

  it('attachOpenCodeSession with knownServerSessionId but no title sends attach_session only', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);
    const fetchMessages = async () => [];

    await bridge.attachOpenCodeSession(
      'opencode-local-4',
      fetchMessages,
      undefined,
      undefined,
      'server-existing-4',
    );

    const sentTypes = relay.sent.map(m => JSON.parse(m).type);

    expect(sentTypes).toContain('attach_session');
    expect(sentTypes).not.toContain('update_session_label');
    expect(sentTypes).not.toContain('register_session');
  });

  it('maps hook-created sessions to windowId so later tab label sync updates relay title', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    await bridge.ensureSession('claude-a', 'window-1');
    const beforeCount = relay.sent.length;

    bridge.setPendingLabel('window-1', 'Fix login bug');

    expect(relay.sent.length).toBe(beforeCount + 1);
    const lastMsg = JSON.parse(relay.sent[relay.sent.length - 1]);
    expect(lastMsg).toEqual({
      type: 'update_session_label',
      payload: {
        sessionId: 'server-claude-a',
        label: 'Fix login bug',
      },
    });
  });

  /** Wait for pending async operations (replayUserPrompts reads transcript files). */
  async function flushAsync(): Promise<void> {
    await new Promise(resolve => setTimeout(resolve, 200));
  }

  describe('user_prompt replay', () => {
    it('does not replay phone-originated commands as user_prompt events', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'Phone sent command');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.ensureSession('claude-a');

        // Simulate phone command being claimed (the claim path, not relay receive)
        bridge.recordClaimedPhoneCommand('server-claude-a', 'Phone sent command');

        // Attach — should NOT replay the phone-originated command
        await bridge.attachClaudeSession('claude-a');
        await flushAsync();

        const promptEvents = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'user_prompt');
        expect(promptEvents.length).toBe(0);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('replays user prompts as events after attach', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'My prompt title');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);
        await bridge.attachClaudeSession('claude-a');
        await flushAsync();
        const promptEvents = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'user_prompt');
        expect(promptEvents.length).toBeGreaterThan(0);
        expect(promptEvents[0].payload.data.type).toBe('user_prompt');
        expect(promptEvents[0].payload.data.prompt).toBeTruthy();
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('does not replay duplicate prompts on re-attach', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'Title');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);
        await bridge.attachClaudeSession('claude-a');
        await flushAsync();
        const beforeCount = relay.sent.length;
        await bridge.attachClaudeSession('claude-a');
        await flushAsync();
        const newPromptEvents = relay.sent.slice(beforeCount)
          .map(m => JSON.parse(m))
          .filter((m: any) => m.payload?.eventType === 'user_prompt');
        expect(newPromptEvents.length).toBe(0);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('syncs newly appended Claude assistant transcript messages', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'First prompt');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.attachClaudeSession('claude-a');
        await flushAsync();
        const beforeCount = relay.sent.length;

        appendTranscriptLine(tmpDir, 'claude-a', {
          type: 'assistant',
          timestamp: '2026-06-04T01:02:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Done from transcript' }] },
        });

        await (bridge as any).syncClaudeTranscript('claude-a', 'server-claude-a');

        const taskEvents = relay.sent.slice(beforeCount)
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'task_complete');
        expect(taskEvents.length).toBe(1);
        expect(taskEvents[0].payload.data.summary).toContain('Done from transcript');
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('clears pending approvals when Claude continues via transcript output', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'First prompt');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.attachClaudeSession('claude-a');
        await flushAsync();
        bridge.trackPendingApproval({
          id: 'approval-1',
          serverSessionId: 'server-claude-a',
          claudeSessionId: 'claude-a',
          agentType: 'claude-code-hook',
          command: 'npm test',
          summary: 'Run tests',
          toolName: 'Bash',
          risk: 'medium',
        });

        appendTranscriptLine(tmpDir, 'claude-a', {
          type: 'assistant',
          timestamp: '2026-06-04T01:02:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Continued after desktop approval' }] },
        });

        await (bridge as any).syncClaudeTranscript('claude-a', 'server-claude-a');

        expect(bridge.getPendingApprovals()).toEqual([]);
        const resolveMsg = relay.sent
          .map(m => JSON.parse(m))
          .find((m: any) => m.type === 'resolve_event' && m.payload.eventId === 'approval-1');
        expect(resolveMsg).toBeDefined();
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('does not duplicate assistant text already sent by session_idle hook', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'First prompt');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.attachClaudeSession('claude-a');
        await flushAsync();

        await bridge.handleHookEvent({
          eventType: 'session_idle',
          claudeSessionId: 'claude-a',
          lastAssistantMessage: 'Same assistant text',
          data: { type: 'session_idle', idleMinutes: 0 },
        });

        const beforeCount = relay.sent.length;
        appendTranscriptLine(tmpDir, 'claude-a', {
          type: 'assistant',
          timestamp: '2026-06-04T01:02:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Same assistant text' }] },
        });

        await (bridge as any).syncClaudeTranscript('claude-a', 'server-claude-a');

        const duplicateTaskEvents = relay.sent.slice(beforeCount)
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'task_complete');
        expect(duplicateTaskEvents.length).toBe(0);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('does not duplicate assistant text already sent by task_complete hook', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'First prompt');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.attachClaudeSession('claude-a');
        await flushAsync();

        await bridge.handleHookEvent({
          eventType: 'task_complete',
          claudeSessionId: 'claude-a',
          data: { type: 'task_complete', summary: 'Same assistant text', summaryShort: 'Same assistant text' },
        });

        const beforeCount = relay.sent.length;
        appendTranscriptLine(tmpDir, 'claude-a', {
          type: 'assistant',
          timestamp: '2026-06-04T01:02:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Same assistant text' }] },
        });

        await (bridge as any).syncClaudeTranscript('claude-a', 'server-claude-a');

        const duplicateTaskEvents = relay.sent.slice(beforeCount)
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'task_complete');
        expect(duplicateTaskEvents.length).toBe(0);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('does not duplicate task_complete hook after transcript sync sent the same text', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'First prompt');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.attachClaudeSession('claude-a');
        await flushAsync();

        appendTranscriptLine(tmpDir, 'claude-a', {
          type: 'assistant',
          timestamp: '2026-06-04T01:02:03.000Z',
          message: { role: 'assistant', content: [{ type: 'text', text: 'Same assistant text' }] },
        });

        await (bridge as any).syncClaudeTranscript('claude-a', 'server-claude-a');

        const beforeCount = relay.sent.length;
        await bridge.handleHookEvent({
          eventType: 'task_complete',
          claudeSessionId: 'claude-a',
          data: { type: 'task_complete', summary: 'Same assistant text', summaryShort: 'Same assistant text' },
        });

        const duplicateTaskEvents = relay.sent.slice(beforeCount)
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'task_complete');
        expect(duplicateTaskEvents.length).toBe(0);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('user_prompt arrives asynchronously after approval_required in handleApproval', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'Fix the login bug');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        // Trigger handleApproval — approval_required is sent immediately, user_prompt arrives async
        const approvalPromise = bridge.handleApproval({
          claudeSessionId: 'claude-a',
          codekeyWindowId: 'window-1',
          source: 'permission_request',
          rawEvent: {
            tool_name: 'Bash',
            tool_input: { command: 'npm test', cwd: 'F:\\Work\\Codekey' },
          },
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        const events = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event');

        // Find indexes of user_prompt and approval_required
        const promptIdx = events.findIndex((e: any) => e.payload.eventType === 'user_prompt');
        const approvalIdx = events.findIndex((e: any) => e.payload.eventType === 'approval_required');

        expect(promptIdx).toBeGreaterThanOrEqual(0);
        expect(approvalIdx).toBeGreaterThanOrEqual(0);
        expect(promptIdx).toBeGreaterThan(approvalIdx);

        // Resolve the pending approval using the APPROVAL event's clientEventId
        // (not the user_prompt event's clientEventId)
        const approvalEvent = events[approvalIdx];
        relay.emit('approval_forward', {
          eventId: approvalEvent.payload.clientEventId,
          clientEventId: approvalEvent.payload.clientEventId,
          decision: 'approve',
        });
        await approvalPromise;
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('does not suppress cross-session prompts (session isolation)', async () => {
      const tmpDir = createTranscriptFixture('claude-a', '继续');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.ensureSession('claude-a');
        // Record phone command in session A
        bridge.recordClaimedPhoneCommand('server-claude-a', '继续');

        // Create a separate transcript for session B with same text
        const tmpDirB = createTranscriptFixture('claude-b', '继续');

        // Switch to tmpDirB for session B operations (ensureSession reads transcript
        // via _registerOnRelay, and attachClaudeSession reads it via extractUserPrompts)
        process.env.CLAUDE_CONFIG_DIR = tmpDirB;
        await bridge.ensureSession('claude-b');
        // attachClaudeSession must still see tmpDirB — don't restore yet
        await bridge.attachClaudeSession('claude-b');
        await flushAsync();

        const promptEventsB = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'user_prompt');
        expect(promptEventsB.length).toBe(1);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('consumes phone command fingerprint only once (one-shot)', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'next step');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.ensureSession('claude-a');
        bridge.recordClaimedPhoneCommand('server-claude-a', 'next step');

        // First attach — should suppress (one-shot consumed)
        await bridge.attachClaudeSession('claude-a');
        await flushAsync();
        const afterFirst = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.payload?.eventType === 'user_prompt');
        expect(afterFirst.length).toBe(0);

        // Reset sentPromptKeys so second attach doesn't hit the line-index dedup
        (bridge as any).sentPromptKeys = new Set();

        // Second attach — fingerprint was consumed, should now replay
        await bridge.attachClaudeSession('claude-a');
        await flushAsync();
        const afterSecond = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.payload?.eventType === 'user_prompt');
        expect(afterSecond.length).toBe(1);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('expired phone command fingerprint no longer suppresses prompts', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'stale command');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        await bridge.ensureSession('claude-a');

        // Record with old timestamp via private method access
        const oldNow = Date.now() - 11 * 60 * 1000; // 11 minutes ago (past 10-min window)
        const fp = (bridge as any).fingerprintText('stale command');
        (bridge as any).recentPhoneCommandsBySession.set('server-claude-a', [
          { fingerprint: fp, recordedAt: oldNow },
        ]);

        // Attach — fingerprint is stale, prompt should be replayed
        await bridge.attachClaudeSession('claude-a');
        await flushAsync();

        const promptEvents = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event' && m.payload.eventType === 'user_prompt');
        expect(promptEvents.length).toBe(1);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });
  });

  describe('transcript fixture tests', () => {
    let tmpDir = '';

    beforeEach(() => {
      tmpDir = createTranscriptFixture('claude-a', 'Real transcript title');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
    });

    afterEach(() => {
      delete process.env.CLAUDE_CONFIG_DIR;
    });

    it('attachClaudeSession without windowId uses transcript title', async () => {
      const relay = new FakeRelay();
      const bridge = new ApprovalBridge(relay as any);

      // Pre-set a label (should NOT be used since no windowId is passed)
      (bridge as any).windowLabels.set('some-window', 'Wrong label');

      await bridge.attachClaudeSession('claude-a');

      const registerMsg = relay.sent
        .map(m => JSON.parse(m))
        .find((m: any) => m.type === 'register_session');

      expect(registerMsg).toBeDefined();
      // Title should fall back to transcript title (not 'Wrong label')
      expect(registerMsg.payload.metadata.title).toBe('Real transcript title');
      expect(registerMsg.payload.metadata.title).not.toBe('Wrong label');
    });

    it('setPendingLabel does not update attach session when no window mapping exists', async () => {
      const relay = new FakeRelay();
      const bridge = new ApprovalBridge(relay as any);

      // Attach a session without windowId (transcript_attach path)
      await bridge.attachClaudeSession('claude-a');
      const beforeCount = relay.sent.length;

      // Simulate label sync — this should NOT send update_session_label
      // because there's no windowSessions entry for this attach session
      bridge.setPendingLabel('some-window', 'New label');

      // Count should be unchanged — setPendingLabel should no-op
      expect(relay.sent.length).toBe(beforeCount);
    });
  });
});

describe('ApprovalBridge hook dedup cleanup', () => {
  it('cleanupHookDedupFingerprints removes entries older than TTL and keeps recent ones', () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const now = Date.now();
    const fps = (bridge as any)._forwardedHookFingerprints as Map<string, number>;
    fps.set('fp-1', now - 25 * 60 * 60 * 1000); // 25h old — expire
    fps.set('fp-2', now - 23 * 60 * 60 * 1000); // 23h old — keep (within 24h TTL)
    fps.set('fp-3', now - 1 * 60 * 60 * 1000);  // 1h old — keep

    const removed = bridge.cleanupHookDedupFingerprints(now);

    expect(removed).toBe(1);
    expect(fps.has('fp-1')).toBe(false);
    expect(fps.has('fp-2')).toBe(true);
    expect(fps.has('fp-3')).toBe(true);
  });

  it('cleanupHookDedupFingerprints returns 0 when no entries are expired', () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const now = Date.now();
    const fps = (bridge as any)._forwardedHookFingerprints as Map<string, number>;
    fps.set('fp-recent', now - 1000);

    const removed = bridge.cleanupHookDedupFingerprints(now);

    expect(removed).toBe(0);
    expect(fps.size).toBe(1);
  });

  it('cleanupHookDedupFingerprints handles empty map', () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const removed = bridge.cleanupHookDedupFingerprints(Date.now());

    expect(removed).toBe(0);
  });

  it('dispose stops background timer and clears the interval reference', () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    (bridge as any).ensureHookDedupCleanup();
    expect((bridge as any)._hookDedupTimer).toBeDefined();

    bridge.dispose();

    expect((bridge as any)._hookDedupTimer).toBeUndefined();
  });

  it('ensureHookDedupCleanup is idempotent (does not create duplicate timers)', () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    (bridge as any).ensureHookDedupCleanup();
    const first = (bridge as any)._hookDedupTimer;
    (bridge as any).ensureHookDedupCleanup();
    const second = (bridge as any)._hookDedupTimer;

    expect(first).toBe(second);

    bridge.dispose();
  });
});

describe('ApprovalBridge pendingDeactivations race handling', () => {
  it('activation failure cleans up stale pendingDeactivations marker', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Stale marker: deactivate happened before activation could complete
    (bridge as any).pendingDeactivations.add('window-1');

    // Force activation to fail (returns null)
    vi.spyOn(bridge as any, '_activateOnRelay').mockResolvedValue(null);

    const result = await bridge.activateSession('window-1');

    expect(result).toBeNull();
    expect((bridge as any).pendingDeactivations.has('window-1')).toBe(false);
  });

  it('activation success with pending deactivate sends deactivate and does not register session', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    (bridge as any).pendingDeactivations.add('window-1');
    vi.spyOn(bridge as any, '_activateOnRelay').mockResolvedValue('server-sess-1');

    const result = await bridge.activateSession('window-1');

    expect(result).toBeNull();
    // deactivate_session sent to relay
    const sentRaw = relay.sent;
    expect(sentRaw.some((s) => s.includes('deactivate_session') && s.includes('server-sess-1'))).toBe(true);
    // marker consumed
    expect((bridge as any).pendingDeactivations.has('window-1')).toBe(false);
    // session NOT registered
    expect((bridge as any).windowSessions.has('window-1')).toBe(false);
  });

  it('activation success without pending deactivate registers session normally', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    vi.spyOn(bridge as any, '_activateOnRelay').mockResolvedValue('server-sess-2');

    const result = await bridge.activateSession('window-2');

    expect(result).toBe('server-sess-2');
    expect((bridge as any).windowSessions.get('window-2')).toBe('server-sess-2');
    expect((bridge as any).pendingDeactivations.has('window-2')).toBe(false);
  });
});

describe('ApprovalBridge pendingPhoneDeliveryCount cleanup paths', () => {
  function setupPendingCount(bridge: ApprovalBridge, sessionId: string) {
    (bridge as any).pendingPhoneDeliveryCount.set(sessionId, 3);
  }

  it('deactivateSession clears pendingPhoneDeliveryCount', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    (bridge as any).windowSessions.set('window-1', 'server-1');
    setupPendingCount(bridge, 'server-1');

    await bridge.deactivateSession('window-1');

    expect((bridge as any).pendingPhoneDeliveryCount.has('server-1')).toBe(false);
  });

  it('deactivateByWindow clears pendingPhoneDeliveryCount for matching windows', () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    (bridge as any).windowSessions.set('window-1', 'server-1');
    setupPendingCount(bridge, 'server-1');

    bridge.deactivateByWindow('window-1');

    expect((bridge as any).pendingPhoneDeliveryCount.has('server-1')).toBe(false);
  });

  it('session_deactivated relay event clears pendingPhoneDeliveryCount', () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    setupPendingCount(bridge, 'server-1');

    relay.emit('session_deactivated', { sessionId: 'server-1' });

    expect((bridge as any).pendingPhoneDeliveryCount.has('server-1')).toBe(false);
  });

  it('deactivateAll clears all pendingPhoneDeliveryCount entries', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    (bridge as any).windowSessions.set('window-1', 'server-1');
    (bridge as any).windowSessions.set('window-2', 'server-2');
    setupPendingCount(bridge, 'server-1');
    setupPendingCount(bridge, 'server-2');

    await bridge.deactivateAll();

    expect((bridge as any).pendingPhoneDeliveryCount.size).toBe(0);
  });

  it('deactivateAll cleans up pendingPhoneDeliveryCount even with empty windowSessions', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Simulate: phone claim succeeded but no window session was created
    setupPendingCount(bridge, 'server-orphan');

    await bridge.deactivateAll();

    expect((bridge as any).pendingPhoneDeliveryCount.has('server-orphan')).toBe(false);
  });

  it('deactivateAll stops hook dedup timer even with empty windowSessions', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Lazy-start the timer (simulate prior hook event)
    (bridge as any).ensureHookDedupCleanup();
    expect((bridge as any)._hookDedupTimer).toBeDefined();

    // No window sessions exist
    await bridge.deactivateAll();

    expect((bridge as any)._hookDedupTimer).toBeUndefined();
  });
});
