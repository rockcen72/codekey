import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalBridge } from '../bridge/handler.js';
import { OpenCodeSessionManager } from '../bridge/opencode-session-manager.js';

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

  beforeEach(() => {
    if (existsSync(attachedStoragePath)) rmSync(attachedStoragePath);
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
  });

  describe('permission.updated', () => {
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

  describe('server.connected', () => {
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
