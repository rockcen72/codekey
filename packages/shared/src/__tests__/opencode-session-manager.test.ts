import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalBridge } from '../bridge/handler.js';
import { discoverLocalOpenCodeSessions, OpenCodeSessionManager } from '../bridge/opencode-session-manager.js';

class FakeRelay extends EventEmitter {
  sent: string[] = [];
  sentEvents: unknown[] = [];
  sendRaw(value: string): void {
    this.sent.push(value);
    const msg = JSON.parse(value);
    if (msg.type === 'register_session') {
      setImmediate(() => {
        this.emit('session_registered', {
          clientRequestId: msg.payload.clientRequestId,
          sessionId: `server-${msg.payload.claudeSessionId || 'unknown'}`,
        });
      });
    }
  }
  sendEvent(_sessionId: string, msg: unknown): void {
    this.sentEvents.push(msg);
  }
}

describe('OpenCodeSessionManager event handling', () => {
  let relay: FakeRelay;
  let bridge: ApprovalBridge;
  let manager: OpenCodeSessionManager;
  const attachedStoragePath = join(tmpdir(), 'codekey-opencode-attached.json');
  const opencodeDataDir = join(tmpdir(), 'codekey-opencode-data-test');

  beforeEach(() => {
    if (existsSync(attachedStoragePath)) rmSync(attachedStoragePath);
    if (existsSync(opencodeDataDir)) rmSync(opencodeDataDir, { recursive: true, force: true });
    process.env.OPENCODE_DATA_DIR = opencodeDataDir;
    relay = new FakeRelay();
    bridge = new ApprovalBridge(relay as any);
    bridge.listenRelayCommands();
    manager = new OpenCodeSessionManager('http://127.0.0.1:4096', bridge);
    // Register handlers without starting SSE
    bridge.registerExternalApprovalResponder({
      agentType: 'opencode',
      onApprovalForward: (eventId, decision, clientEventId) =>
        manager.handleApprovalForward(eventId, decision, clientEventId),
    });
    bridge.registerAgentCommandHandler({
      ownsSession: (sid) => manager.ownsSession(sid),
      handleCommand: (payload) => manager.handleCommand(payload.sessionId, payload.data),
    });
    bridge.onEventAck((clientEventId, serverEventId) => {
      // Migrate permissionMap keys
      const entry = (manager as any).permissionMap.get(clientEventId);
      if (entry) {
        (manager as any).permissionMap.set(serverEventId, entry);
      }
    });
  });

  afterEach(() => {
    if (existsSync(attachedStoragePath)) rmSync(attachedStoragePath);
    if (existsSync(opencodeDataDir)) rmSync(opencodeDataDir, { recursive: true, force: true });
    delete process.env.OPENCODE_DATA_DIR;
    vi.restoreAllMocks();
  });

  describe('permission.asked/updated', () => {
    it('creates approval from OpenCode permission.asked event', async () => {
      const permissionEvent = {
        type: 'permission.asked',
        properties: {
          id: 'perm-asked',
          permission: 'Bash',
          sessionID: 'oc-session-asked',
          messageID: 'msg-asked',
          metadata: { command: 'npm test' },
          time: { created: Date.now() },
        },
      };

      await (manager as any).handleSSEEvent(permissionEvent);

      expect(manager.ownsSession('server-oc-session-asked')).toBe(true);

      const pending = bridge.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].agentType).toBe('opencode');
      expect(pending[0].command).toBe('npm test');
      expect(pending[0].toolName).toBe('Bash');
    });

    it('creates approval from Permission object', async () => {
      const permissionEvent = {
        type: 'permission.updated',
        properties: {
          id: 'perm-123',
          type: 'Bash',
          sessionID: 'oc-session-1',
          messageID: 'msg-1',
          title: 'Run bash command',
          metadata: { command: 'npm test' },
          time: { created: Date.now() },
        },
      };

      // Access private method via any cast for testing
      await (manager as any).handleSSEEvent(permissionEvent);

      // Should have registered the session
      expect(manager.ownsSession('server-oc-session-1')).toBe(true);

      // Should have tracked pending approval
      const pending = bridge.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].agentType).toBe('opencode');
      expect(pending[0].command).toBe('npm test');

      // Should have stored permission mapping
      const permMap = (manager as any).permissionMap;
      expect(permMap.size).toBe(1);
      const entry = permMap.values().next().value;
      expect(entry.requestID).toBe('perm-123');
      expect(entry.localSessionID).toBe('oc-session-1');
    });

    it('uses title field as summary', async () => {
      const permissionEvent = {
        type: 'permission.updated',
        properties: {
          id: 'perm-456',
          type: 'Edit',
          sessionID: 'oc-session-2',
          messageID: 'msg-2',
          title: 'Edit file: src/main.ts',
          metadata: {},
          time: { created: Date.now() },
        },
      };

      await (manager as any).handleSSEEvent(permissionEvent);

      const pending = bridge.getPendingApprovals();
      expect(pending.length).toBe(1);
      expect(pending[0].summary).toBe('Edit file: src/main.ts');
    });

    it('replies to OpenCode approvals through the current permission endpoint', async () => {
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
      globalThis.fetch = fetchSpy as any;
      try {
        await (manager as any).handleSSEEvent({
          type: 'permission.asked',
          properties: {
            id: 'perm-reply',
            permission: 'Bash',
            sessionID: 'oc-session-reply',
            metadata: { command: 'npm test' },
            time: { created: Date.now() },
          },
        });

        const handled = await manager.handleApprovalForward('oc-perm:perm-reply', 'approve');

        expect(handled).toBe(true);
        expect(bridge.getPendingApprovals()).toEqual([]);
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://127.0.0.1:4096/permission/perm-reply/reply',
          expect.objectContaining({
            method: 'POST',
            body: JSON.stringify({ reply: 'once' }),
          }),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('clears local pending approval on permission.replied SSE', async () => {
      await (manager as any).handleSSEEvent({
        type: 'permission.asked',
        properties: {
          id: 'perm-replied',
          permission: 'Bash',
          sessionID: 'oc-session-replied',
          metadata: { command: 'npm test' },
          time: { created: Date.now() },
        },
      });
      expect(bridge.getPendingApprovals()).toHaveLength(1);

      await (manager as any).handleSSEEvent({
        type: 'permission.replied',
        properties: { id: 'perm-replied' },
      });

      expect(bridge.getPendingApprovals()).toEqual([]);
    });
  });

  describe('session.created/deleted', () => {
    it('extracts sessionID from properties.info', async () => {
      const createEvent = {
        type: 'session.created',
        properties: {
          info: {
            id: 'oc-session-3',
            projectID: 'proj-1',
            directory: '/home/user/project',
            title: 'Test session',
            version: '1.0',
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      };

      await (manager as any).handleSSEEvent(createEvent);

      // session.created alone doesn't register in opencodeSessions
      // (that happens on permission.updated)
      expect(manager.ownsSession('server-oc-session-3')).toBe(false);
    });

    it('cleans up session on session.deleted', async () => {
      // First register a session via permission
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-789',
          type: 'Bash',
          sessionID: 'oc-session-4',
          messageID: 'msg-4',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });
      expect(manager.ownsSession('server-oc-session-4')).toBe(true);

      // Now delete it
      await (manager as any).handleSSEEvent({
        type: 'session.deleted',
        properties: {
          info: {
            id: 'oc-session-4',
            projectID: 'proj-1',
            directory: '/home/user/project',
            title: 'Test',
            version: '1.0',
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      });

      expect(manager.ownsSession('server-oc-session-4')).toBe(false);
    });

    it('syncs renamed OpenCode session title to relay', async () => {
      await manager.attachSession('ses_1790', 'Initial title', 'server-ses_1790');
      relay.sent.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'session.updated',
        properties: {
          info: {
            id: 'ses_1790',
            title: 'Renamed session',
          },
        },
      });

      const labelUpdate = relay.sent
        .map((raw) => JSON.parse(raw))
        .find((msg) => msg.type === 'update_session_label');
      expect(labelUpdate).toMatchObject({
        payload: { sessionId: 'server-ses_1790', label: 'Renamed session' },
      });
    });
  });

  describe('attachSession persistence', () => {
    it('uses a known remote server session id instead of registering again', async () => {
      await manager.attachSession('oc-session-remote', 'Remote title', 'server-existing-remote');

      expect(manager.ownsSession('server-existing-remote')).toBe(true);
      expect(bridge.getAttachedSessionIds()).toContain('oc-session-remote');

      const registrations = relay.sent
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === 'register_session' && msg.payload.claudeSessionId === 'oc-session-remote');
      expect(registrations.length).toBe(0);
    });

    it('restores attached mappings even when the current OpenCode API list is empty', async () => {
      writeFileSync(attachedStoragePath, JSON.stringify([
        { localSessionId: 'ses_stored', serverSessionId: 'server-stored' },
      ]), 'utf-8');
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/session')) return { ok: true, json: async () => [] } as Response;
        return { ok: true, body: null } as Response;
      }));

      const restoredManager = new OpenCodeSessionManager('http://127.0.0.1:4096', bridge);
      vi.spyOn(restoredManager as any, 'connectSSE').mockResolvedValue(undefined);
      await restoredManager.start();

      expect(restoredManager.ownsSession('server-stored')).toBe(true);
      expect(bridge.getAttachedSessionIds()).toContain('ses_stored');
      restoredManager.stop();
    });
  });

  describe('local session discovery', () => {
    it('discovers OpenCode sessions from local storage when the HTTP server is empty', async () => {
      const sessionDir = join(opencodeDataDir, 'storage', 'session', 'global');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ses_local.json'), JSON.stringify({
        id: 'ses_local',
        directory: 'F:/Work/Codekey',
        title: 'Local OpenCode title',
        time: { created: 1, updated: 20 },
      }), 'utf-8');
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/session')) return { ok: true, json: async () => [] } as Response;
        return { ok: true, body: null } as Response;
      }));

      expect(discoverLocalOpenCodeSessions()).toMatchObject([
        { id: 'ses_local', title: 'Local OpenCode title', directory: 'F:/Work/Codekey' },
      ]);
      await expect(manager.listSessions()).resolves.toMatchObject([
        { id: 'ses_local', title: 'Local OpenCode title', directory: 'F:/Work/Codekey' },
      ]);
    });
  });

  describe('message.part.updated', () => {
    it('forwards text part content to relay', async () => {
      // First register session
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-text',
          type: 'Bash',
          sessionID: 'oc-session-5',
          messageID: 'msg-5',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0; // Clear sent messages
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-1',
            sessionID: 'oc-session-5',
            messageID: 'msg-5',
            type: 'text',
            text: 'Hello from OpenCode!',
          },
        },
      });

      // Should have sent a task_complete event via sendEvent
      const events = relay.sentEvents as any[];
      const taskComplete = events.find(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskComplete).toBeDefined();
      expect(taskComplete.payload.data.summary).toBe('Hello from OpenCode!');
    });

    it('deduplicates same part ID', async () => {
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-dedup',
          type: 'Bash',
          sessionID: 'oc-session-6',
          messageID: 'msg-6',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      const partEvent = {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-dedup',
            sessionID: 'oc-session-6',
            messageID: 'msg-6',
            type: 'text',
            text: 'Duplicate test',
          },
        },
      };

      await (manager as any).handleSSEEvent(partEvent);
      await (manager as any).handleSSEEvent(partEvent);

      const events = relay.sentEvents as any[];
      const taskCompletes = events.filter(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskCompletes.length).toBe(1);
    });
  });

  describe('session.idle', () => {
    it('sends task_complete on session idle', async () => {
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-idle',
          type: 'Bash',
          sessionID: 'oc-session-7',
          messageID: 'msg-7',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'session.idle',
        properties: {
          sessionID: 'oc-session-7',
        },
      });

      const events = relay.sentEvents as any[];
      const taskComplete = events.find(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskComplete).toBeDefined();
    });

    it('surfaces error info from session.idle props as an error event', async () => {
      // Register a session mapping so onSessionIdle can resolve it.
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-idle-err',
          type: 'Bash',
          sessionID: 'oc-session-7e',
          messageID: 'msg-7e',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      // OpenCode's session.idle sometimes carries an error payload even
      // when no separate session.error event was emitted (e.g. agent
      // gave up on a task). The phone needs the reason, not just
      // "Session idle".
      await (manager as any).handleSSEEvent({
        type: 'session.idle',
        properties: {
          sessionID: 'oc-session-7e',
          error: { message: 'Agent exceeded max iterations and aborted' },
        },
      });

      const events = relay.sentEvents as any[];
      const errorEvent = events.find(
        (e: any) => e.payload?.eventType === 'error',
      );
      expect(errorEvent).toBeDefined();
      expect(errorEvent.payload.data.message).toBe(
        'Agent exceeded max iterations and aborted',
      );

      // task_complete should still fire so the phone UI knows the
      // turn is over.
      const taskComplete = events.find(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskComplete).toBeDefined();
    });
  });

  describe('message.part.updated — phone-sent text echo', () => {
    it('does NOT forward the echoed phone prompt as agent text', async () => {
      // Register session mapping via permission event.
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-echo',
          type: 'Bash',
          sessionID: 'oc-session-echo',
          messageID: 'msg-echo',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      // Simulate the phone-sent command: in production this happens in
      // handleCommand(), but we want to avoid the fetch side-effect, so
      // we call the tracker directly.
      (manager as any)._trackPhoneCommand('oc-session-echo', '查询上海天气');

      // OpenCode echoes the user input as a text part on the user
      // message. Without the fix, this fired a task_complete event
      // marked as the agent's reply.
      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-echo-1',
            sessionID: 'oc-session-echo',
            messageID: 'msg-echo',
            type: 'text',
            text: '查询上海天气',
          },
        },
      });

      const events = relay.sentEvents as any[];
      const echoAsTaskComplete = events.find(
        (e: any) =>
          e.payload?.eventType === 'task_complete' &&
          e.payload?.data?.summary === '查询上海天气',
      );
      expect(echoAsTaskComplete).toBeUndefined();
    });

    it('still forwards genuine agent text even after a phone command', async () => {
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-genuine',
          type: 'Bash',
          sessionID: 'oc-session-genuine',
          messageID: 'msg-genuine',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      (manager as any)._trackPhoneCommand('oc-session-genuine', '查询上海天气');

      // The agent's actual reply — different text, should pass through.
      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-genuine-1',
            sessionID: 'oc-session-genuine',
            messageID: 'msg-genuine',
            type: 'text',
            text: '上海今天多云，气温 22°C。',
          },
        },
      });

      const events = relay.sentEvents as any[];
      const taskComplete = events.find(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskComplete).toBeDefined();
      expect(taskComplete.payload.data.summary).toBe('上海今天多云，气温 22°C。');
    });

    it('does not consume the fingerprint on first match (allows multiple checks)', async () => {
      // Regression guard: when message.part.updated fires before
      // message.updated for the same user input, the part handler must
      // not delete the entry that the message handler also needs.
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-multi',
          type: 'Bash',
          sessionID: 'oc-session-multi',
          messageID: 'msg-multi',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      (manager as any)._trackPhoneCommand('oc-session-multi', 'hello world');

      // First check: text part — should suppress.
      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-multi-1',
            sessionID: 'oc-session-multi',
            messageID: 'msg-multi',
            type: 'text',
            text: 'hello world',
          },
        },
      });

      // Second check: message.updated (TUI echo) — must STILL see the
      // fingerprint as recent and suppress the user_prompt emission.
      await (manager as any).handleSSEEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-multi',
            sessionID: 'oc-session-multi',
            role: 'user',
            summary: { body: 'hello world' },
          },
        },
      });

      // The text-part echo must not have produced a task_complete.
      const events = relay.sentEvents as any[];
      const echo = events.find(
        (e: any) =>
          e.payload?.eventType === 'task_complete' &&
          e.payload?.data?.summary === 'hello world',
      );
      expect(echo).toBeUndefined();

      // The TUI-echo user_prompt must not have fired either.
      const userPrompts = events.filter(
        (e: any) => e.payload?.eventType === 'user_prompt',
      );
      expect(userPrompts.length).toBe(0);
    });
  });

  describe('message.part.updated — streaming agent response', () => {
    // Regression guard: the agent's actual text response was being
    // dropped because the partID was added to the dedup set on the
    // first event (text="") and the second event (the real text) was
    // suppressed by the same dedup key. Phone only saw the generic
    // "Session idle" task_complete with no summary.

    it('forwards the real text when the first text-part event is empty', async () => {
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-stream-empty',
          type: 'Bash',
          sessionID: 'oc-session-stream-empty',
          messageID: 'msg-stream-empty',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      // OpenCode often creates the part with empty text first, then
      // updates it with the real content. The old code added partID
      // to the dedup set before the empty-text check, so the second
      // event was dropped.
      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-stream-empty',
            sessionID: 'oc-session-stream-empty',
            messageID: 'msg-stream-empty',
            type: 'text',
            text: '',
          },
        },
      });

      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-stream-empty',
            sessionID: 'oc-session-stream-empty',
            messageID: 'msg-stream-empty',
            type: 'text',
            text: '上海今天多云，气温 22°C。',
          },
        },
      });

      const events = relay.sentEvents as any[];
      const realResponse = events.find(
        (e: any) =>
          e.payload?.eventType === 'task_complete' &&
          e.payload?.data?.summary === '上海今天多云，气温 22°C。',
      );
      expect(realResponse).toBeDefined();
    });

    it('forwards each streaming text chunk (different text per update)', async () => {
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-stream-chunks',
          type: 'Bash',
          sessionID: 'oc-session-stream-chunks',
          messageID: 'msg-stream-chunks',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      // OpenCode may also fire multiple updates with growing text.
      // Each unique (partID, text) should be allowed through.
      for (const text of ['H', 'He', 'Hello', 'Hello world']) {
        await (manager as any).handleSSEEvent({
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'part-stream-chunks',
              sessionID: 'oc-session-stream-chunks',
              messageID: 'msg-stream-chunks',
              type: 'text',
              text,
            },
          },
        });
      }

      const events = relay.sentEvents as any[];
      const summaries = events
        .filter((e: any) => e.payload?.eventType === 'task_complete')
        .map((e: any) => e.payload?.data?.summary);

      // The last (and longest) text must be among the delivered
      // summaries — that is the user-visible final answer.
      expect(summaries).toContain('Hello world');
    });

    it('still dedupes when the exact same text is re-fired', async () => {
      // Regression guard for the original 'deduplicates same part ID'
      // test — same content, fired twice, must produce only ONE
      // task_complete. We changed the dedup key to (partID, text)
      // so this is the explicit check that the new key still
      // suppresses exact duplicates.
      await (manager as any).handleSSEEvent({
        type: 'permission.updated',
        properties: {
          id: 'perm-dup-text',
          type: 'Bash',
          sessionID: 'oc-session-dup-text',
          messageID: 'msg-dup-text',
          title: 'Test',
          metadata: {},
          time: { created: Date.now() },
        },
      });

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      const partEvent = {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-dup-text',
            sessionID: 'oc-session-dup-text',
            messageID: 'msg-dup-text',
            type: 'text',
            text: 'Same content, fired twice',
          },
        },
      };

      await (manager as any).handleSSEEvent(partEvent);
      await (manager as any).handleSSEEvent(partEvent);

      const events = relay.sentEvents as any[];
      const taskCompletes = events.filter(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskCompletes.length).toBe(1);
    });
  });

  describe('session.created', () => {
    it('does not push a new local session to relay by itself', async () => {
      await (manager as any).handleSSEEvent({
        type: 'session.created',
        properties: {
          info: {
            id: 'oc-session-auto',
            projectID: 'proj-1',
            directory: '/home/user/project',
            title: 'Auto session',
            version: '1.0',
            time: { created: Date.now(), updated: Date.now() },
          },
        },
      });

      await new Promise(r => setTimeout(r, 50));
      expect(manager.ownsSession('server-oc-session-auto')).toBe(false);

      const registrations = relay.sent
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === 'register_session' && msg.payload.claudeSessionId === 'oc-session-auto');
      expect(registrations.length).toBe(0);
    });
  });

  describe('ensureRelaySession title passthrough', () => {
    it('writes providedTitle into register_session payload.metadata.title', async () => {
      await (manager as any).ensureRelaySession('oc-pass-title', 'My OpenCode Task');

      const registerMsg = relay.sent
        .map((raw) => JSON.parse(raw))
        .find((m: any) => m.type === 'register_session' && m.payload.claudeSessionId === 'oc-pass-title');

      expect(registerMsg).toBeDefined();
      expect(registerMsg.payload.metadata.title).toBe('My OpenCode Task');
      expect(registerMsg.payload.metadata.runtime).toBe('opencode');
      expect(registerMsg.payload.metadata.source).toBe('opencode');
    });

    it('omits metadata.title when no providedTitle given', async () => {
      await (manager as any).ensureRelaySession('oc-no-title');

      const registerMsg = relay.sent
        .map((raw) => JSON.parse(raw))
        .find((m: any) => m.type === 'register_session' && m.payload.claudeSessionId === 'oc-no-title');

      expect(registerMsg).toBeDefined();
      expect('title' in registerMsg.payload.metadata).toBe(false);
    });

    it('reuses cached serverSessionId on second call without re-registering', async () => {
      await (manager as any).ensureRelaySession('oc-cached', 'Title 1');

      const initialRegistrations = relay.sent
        .map((raw) => JSON.parse(raw))
        .filter((m: any) => m.type === 'register_session' && m.payload.claudeSessionId === 'oc-cached');
      expect(initialRegistrations.length).toBe(1);

      const second = await (manager as any).ensureRelaySession('oc-cached', 'Title 2 — should be ignored');

      const laterRegistrations = relay.sent
        .map((raw) => JSON.parse(raw))
        .filter((m: any) => m.type === 'register_session' && m.payload.claudeSessionId === 'oc-cached');
      expect(laterRegistrations.length).toBe(1);
      expect(second).toBe('server-oc-cached');
    });
  });

  describe('server.connected', () => {
    it('restores attached sessions even when the current OpenCode session list omits them', async () => {
      writeFileSync(attachedStoragePath, JSON.stringify([
        { localSessionId: 'ses_local_a', serverSessionId: 'server-ses_local_a' },
      ]), 'utf-8');

      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (input: string | URL | Request) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/session')) {
            return {
              ok: true,
              json: async () => [{ id: 'real-session' }],
            } as Response;
          }
          return originalFetch(input);
        };
        vi.spyOn(manager as any, 'connectSSE').mockResolvedValue(undefined);

        await manager.start();

        expect(bridge.getAttachedSessionIds()).toContain('ses_local_a');
        expect(manager.ownsSession('server-ses_local_a')).toBe(true);
      } finally {
        globalThis.fetch = originalFetch;
        manager.stop();
      }
    });

    it('does not push existing OpenCode sessions to relay automatically', async () => {
      const originalFetch = globalThis.fetch;
      try {
        const fetchSpy = vi.fn();
        globalThis.fetch = async (input: string | URL | Request) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/session')) {
            fetchSpy(url);
            return {
              ok: true,
              json: async () => [
                { id: 'existing-session-1' },
                { id: 'existing-session-2' },
              ],
            } as Response;
          }
          return originalFetch(input);
        };

        await (manager as any).handleSSEEvent({ type: 'server.connected', properties: {} });
        await new Promise(r => setTimeout(r, 50));

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(manager.ownsSession('server-existing-session-1')).toBe(false);
        expect(manager.ownsSession('server-existing-session-2')).toBe(false);
        const registrations = relay.sent
          .map((raw) => JSON.parse(raw))
          .filter((msg) => msg.type === 'register_session');
        expect(registrations.length).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
