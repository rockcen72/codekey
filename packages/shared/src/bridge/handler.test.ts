import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApprovalBridge } from './handler.js';

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

class FakeRelay extends EventEmitter {
  sent: string[] = [];
  attachedSessions: { id: string; claudeSessionId: string | null }[] = [];

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
      { id: expect.any(String), text: 'next step' },
    ]);
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

  it('deduplicates identical approval hooks while the approval is pending', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);
    const body = {
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
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

  it('includes readable approval text for non-Bash tool requests', async () => {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    const approval = bridge.handleApproval({
      claudeSessionId: 'claude-a',
      codekeyWindowId: 'window-1',
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

  it('detachClaudeSession sends deactivate_session to relay but does not immediately clear cache', async () => {
    const tmpDir = createTranscriptFixture('claude-a', 'Real transcript title');
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
    const relay = new FakeRelay();
    const bridge = new ApprovalBridge(relay as any);

    // Attach a session first
    await bridge.attachClaudeSession('claude-a');
    expect(relay.sent.length).toBeGreaterThan(0);

    // Detach — should send deactivate_session but keep local cache
    const beforeSentCount = relay.sent.length;
    const result = await bridge.detachClaudeSession('claude-a');

    expect(result).toEqual({ ok: true });
    // Should have sent one more message: deactivate_session
    expect(relay.sent.length).toBe(beforeSentCount + 1);
    const lastMsg = JSON.parse(relay.sent[relay.sent.length - 1]);
    expect(lastMsg.type).toBe('deactivate_session');
    expect(lastMsg.payload.sessionId).toBe('server-claude-a');

    // Cache should NOT be cleared yet — detachClaudeSession is fire-and-forget
    expect(bridge.getAttachedSessionIds()).toContain('claude-a');
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

  it('reconcileAttachedSessions removes stale transcript sessions absent from relay response', async () => {
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

    // stale-session should be removed (not in relay response)
    expect(bridge.getAttachedSessionIds()).not.toContain('stale-session');
    // fresh-session should remain (in relay response)
    expect(bridge.getAttachedSessionIds()).toContain('fresh-session');
    // transcriptAttachedIds should be pruned to match relay
    const ids = Array.from((bridge as any).transcriptAttachedIds);
    expect(ids).toEqual(['fresh-session']);
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
        const beforeCount = relay.sent.length;
        await bridge.attachClaudeSession('claude-a');
        const newPromptEvents = relay.sent.slice(beforeCount)
          .map(m => JSON.parse(m))
          .filter((m: any) => m.payload?.eventType === 'user_prompt');
        expect(newPromptEvents.length).toBe(0);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('replays user_prompt before approval_required during handleApproval', async () => {
      const tmpDir = createTranscriptFixture('claude-a', 'Fix the login bug');
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const relay = new FakeRelay();
        const bridge = new ApprovalBridge(relay as any);

        // Trigger handleApproval — this should replay prompt THEN send approval
        const approvalPromise = bridge.handleApproval({
          claudeSessionId: 'claude-a',
          codekeyWindowId: 'window-1',
          rawEvent: {
            tool_name: 'Bash',
            tool_input: { command: 'npm test', cwd: 'F:\\Work\\Codekey' },
          },
        });

        // Use setTimeout to wait — extractUserPrompts reads the transcript file
        // asynchronously and needs the I/O to complete in the poll phase.
        await new Promise(resolve => setTimeout(resolve, 100));
        await new Promise(resolve => setImmediate(resolve));

        const events = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.type === 'event');

        // Find indexes of user_prompt and approval_required
        const promptIdx = events.findIndex((e: any) => e.payload.eventType === 'user_prompt');
        const approvalIdx = events.findIndex((e: any) => e.payload.eventType === 'approval_required');

        expect(promptIdx).toBeGreaterThanOrEqual(0);
        expect(approvalIdx).toBeGreaterThanOrEqual(0);
        expect(promptIdx).toBeLessThan(approvalIdx);

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
        const afterFirst = relay.sent
          .map(m => JSON.parse(m))
          .filter((m: any) => m.payload?.eventType === 'user_prompt');
        expect(afterFirst.length).toBe(0);

        // Reset sentPromptKeys so second attach doesn't hit the line-index dedup
        (bridge as any).sentPromptKeys = new Set();

        // Second attach — fingerprint was consumed, should now replay
        await bridge.attachClaudeSession('claude-a');
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
