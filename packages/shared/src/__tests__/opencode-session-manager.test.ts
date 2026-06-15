import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalBridge } from '../bridge/handler.js';
import { discoverLocalOpenCodeSessions, OpenCodeSessionManager } from '../bridge/opencode-session-manager.js';
import { HistorySharePolicy, setConfig } from '../bridge/history-policy.js';

vi.mock('../bridge/platform.js', async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return { ...mod, discoverOpenCodePort: vi.fn(() => 4096) };
});
import { discoverOpenCodePort } from '../bridge/platform.js';

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
    // Mirror real sendEvent semantics: event-type messages also land in sentEvents
    // so tests can find events without parsing raw strings.
    if (msg.type === 'event') {
      this.sentEvents.push(msg);
    }
  }
  sendEvent(_sessionId: string, msg: unknown): void {
    this.sentEvents.push(msg);
  }
  sendCheckedPayload(payload: { raw: string }): void {
    this.sendRaw(payload.raw);
  }
}

/** Pre-register an OpenCode session so event handlers can resolve it.
 *  This mirrors the opt-in design: user must click Sync in the sidebar
 *  before any permission/chat/input events leave the desktop. */
async function registerOCSession(manager: OpenCodeSessionManager, localId: string, serverId: string): Promise<void> {
  await manager.attachSession(localId, 'Test', serverId);
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
    // Default to Recent so streaming/text/task tests can send events
    setConfig('*', { policy: HistorySharePolicy.Recent, updatedAt: Date.now() });
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
      await registerOCSession(manager, 'oc-session-asked', 'server-oc-session-asked');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

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
      await registerOCSession(manager, 'oc-session-1', 'server-oc-session-1');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

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
      await registerOCSession(manager, 'oc-session-2', 'server-oc-session-2');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

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

    it('replies to OpenCode approvals through the current permission endpoint (1st)', async () => {
      await registerOCSession(manager, 'oc-session-reply', 'server-oc-session-reply');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;
      // Prime the permission mapping so handleApprovalForward can find it
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

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
      globalThis.fetch = fetchSpy as any;
      try {
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

    it('replies to OpenCode approvals through the current permission endpoint (2nd)', async () => {
      await registerOCSession(manager, 'oc-session-reply', 'server-oc-session-reply');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;
      // Prime the permission mapping
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

      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
      globalThis.fetch = fetchSpy as any;
      try {
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

    it('re-discovers OpenCode port before each approval forward (handles restart race)', async () => {
      // Regression: if OpenCode restarts between the permission event and
      // the phone's decision, the SSE may not have reconnected yet but the
      // fetch still needs the new port. Verify refreshOpenCodeUrl is called
      // and the fetch uses the new port.
      await registerOCSession(manager, 'oc-session-rebind', 'server-oc-session-rebind');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;
      // Prime the permission mapping
      await (manager as any).handleSSEEvent({
        type: 'permission.asked',
        properties: {
          id: 'perm-rebind',
          permission: 'Bash',
          sessionID: 'oc-session-rebind',
          metadata: { command: 'echo hi' },
          time: { created: Date.now() },
        },
      });

      (discoverOpenCodePort as unknown as Mock).mockReturnValueOnce(20031);
      const refreshSpy = vi.spyOn(manager as any, 'refreshOpenCodeUrl');
      const originalFetch = globalThis.fetch;
      const fetchSpy = vi.fn(async () => ({ ok: true }) as Response);
      globalThis.fetch = fetchSpy as any;
      try {
        await manager.handleApprovalForward('oc-perm:perm-rebind', 'approve');

        expect(refreshSpy).toHaveBeenCalled();
        // After refreshOpenCodeUrl discovers the new port, fetch should use it
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://127.0.0.1:20031/permission/perm-rebind/reply',
          expect.objectContaining({ method: 'POST' }),
        );
      } finally {
        globalThis.fetch = originalFetch;
        refreshSpy.mockRestore();
      }
    });

    it('error message includes the request URL (so phone can show why it failed)', async () => {
      await registerOCSession(manager, 'oc-session-fail', 'server-oc-session-fail');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;
      // Prime the permission mapping
      await (manager as any).handleSSEEvent({
        type: 'permission.asked',
        properties: {
          id: 'perm-fail',
          permission: 'Bash',
          sessionID: 'oc-session-fail',
          metadata: { command: 'rm -rf /' },
          time: { created: Date.now() },
        },
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async () => ({ status: 500, ok: false } as Response)) as any;
      try {
        await manager.handleApprovalForward('oc-perm:perm-fail', 'approve');

        // dump relay.sent for debugging if assertion fails
        const errorEvent = (relay as any).sent.find((s: string) =>
          s.includes('"eventType":"error"'),
        );
        expect(errorEvent, `relay.sent was: ${JSON.stringify((relay as any).sent)}`).toBeDefined();
        const parsed = JSON.parse(errorEvent!);
        const flat = JSON.stringify(parsed);
        expect(flat).toContain('http://127.0.0.1:4096/permission/perm-fail/reply');
        expect(flat).toContain('500');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('accepts permissionId/permission_id field names for requestID (defense vs OpenCode schema changes)', async () => {
      await registerOCSession(manager, 'oc-session-camel', 'server-oc-session-camel');
      await registerOCSession(manager, 'oc-session-snake', 'server-oc-session-snake');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'permission.asked',
        properties: {
          permissionId: 'perm-camel',
          permission: 'Bash',
          sessionID: 'oc-session-camel',
          metadata: { command: 'ls' },
          time: { created: Date.now() },
        },
      });
      expect(bridge.getPendingApprovals().length).toBe(1);
      expect(bridge.getPendingApprovals()[0].toolName).toBe('Bash');

      await (manager as any).handleSSEEvent({
        type: 'permission.asked',
        properties: {
          permission_id: 'perm-snake',
          permission: 'Bash',
          sessionID: 'oc-session-snake',
          metadata: { command: 'ls' },
          time: { created: Date.now() },
        },
      });
      expect(bridge.getPendingApprovals().length).toBe(2);
    });

    it('clears local pending approval on permission.replied SSE', async () => {
      await registerOCSession(manager, 'oc-session-replied', 'server-oc-session-replied');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

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

  describe('permission subagent guardrail', () => {
    it('does NOT create approval events for subagent session permissions', async () => {
      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      subagentSet.add('oc-subagent-perm');

      await (manager as any).handleSSEEvent({
        type: 'permission.asked',
        properties: {
          id: 'perm-subagent',
          permission: 'Bash',
          sessionID: 'oc-subagent-perm',
          messageID: 'msg-subagent-perm',
          metadata: { command: 'rm -rf /' },
          time: { created: Date.now() },
        },
      });

      // Subagent permission should NOT create pending approvals
      const pending = bridge.getPendingApprovals();
      expect(pending.length).toBe(0);
      // Session should NOT have been registered
      expect(manager.ownsSession('server-oc-subagent-perm')).toBe(false);
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
      // First register a session via attachSession
      await registerOCSession(manager, 'oc-session-4', 'server-oc-session-4');
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

    it('marks manual detach so mobile history hides the finished session', async () => {
      await manager.detachSession('oc-manual-detach', 'server-oc-manual-detach');

      const msg = relay.sent
        .map((raw) => JSON.parse(raw))
        .find((m: any) => m.type === 'deactivate_session');
      expect(msg?.payload).toEqual({
        sessionId: 'server-oc-manual-detach',
        reason: 'manual_detach',
      });
    });

    it('marks session as subagent when info.type === "subagent"', async () => {
      await (manager as any).handleSSEEvent({
        type: 'session.created',
        properties: {
          info: {
            id: 'oc-sub-type',
            type: 'subagent',
            title: 'explore',
          },
        },
      });

      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      expect(subagentSet.has('oc-sub-type')).toBe(true);
    });

    it('marks session as subagent when info.subagent is true', async () => {
      await (manager as any).handleSSEEvent({
        type: 'session.created',
        properties: {
          info: {
            id: 'oc-sub-flag',
            subagent: true,
            title: 'general',
          },
        },
      });

      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      expect(subagentSet.has('oc-sub-flag')).toBe(true);
    });

    it('marks session as subagent when title starts with @', async () => {
      await (manager as any).handleSSEEvent({
        type: 'session.created',
        properties: {
          info: {
            id: 'oc-sub-at',
            title: '@explore codebase',
          },
        },
      });

      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      expect(subagentSet.has('oc-sub-at')).toBe(true);
    });

    it('does not mark normal sessions as subagent', async () => {
      await (manager as any).handleSSEEvent({
        type: 'session.created',
        properties: {
          info: {
            id: 'oc-normal',
            title: 'My real task',
          },
        },
      });

      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      expect(subagentSet.has('oc-normal')).toBe(false);
    });

    it('removes subagent tag on session.deleted', async () => {
      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      subagentSet.add('oc-sub-cleanup');

      await (manager as any).handleSSEEvent({
        type: 'session.deleted',
        properties: {
          info: { id: 'oc-sub-cleanup' },
        },
      });

      expect(subagentSet.has('oc-sub-cleanup')).toBe(false);
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

    it('preserves top-level OpenCode history roles during attach replay', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/session/oc-history-role/message')) {
          return {
            ok: true,
            json: async () => [
              {
                role: 'user',
                parts: [{ type: 'text', text: 'desktop prompt from reload' }],
                info: { time: { created: Date.now() } },
              },
              {
                role: 'assistant',
                parts: [{ type: 'text', text: 'agent reply from reload' }],
                info: { time: { created: Date.now() } },
              },
            ],
          } as Response;
        }
        return { ok: true, body: null } as Response;
      }));

      await manager.attachSession('oc-history-role', 'History role', 'server-history-role');
      await new Promise((resolve) => setTimeout(resolve, 20));

      const events = relay.sentEvents as any[];
      const userPrompt = events.find((e: any) => e.payload?.eventType === 'user_prompt');
      const taskComplete = events.find((e: any) => e.payload?.eventType === 'task_complete');

      expect(userPrompt?.payload.data.prompt).toBe('desktop prompt from reload');
      expect(taskComplete?.payload.data.summary).toBe('agent reply from reload');
    });

    it('preserves nested part roles during explicit OpenCode history replay', async () => {
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.includes('/session/oc-history-part-role/message')) {
          return {
            ok: true,
            json: async () => [
              {
                parts: [{ type: 'text', text: 'desktop prompt from part role', role: 'user' }],
                info: { time: { created: Date.now() } },
              },
            ],
          } as Response;
        }
        return { ok: true, body: null } as Response;
      }));
      (manager as any).opencodeSessionToRelayId.set('oc-history-part-role', 'server-history-part-role');
      (manager as any).opencodeSessions.add('server-history-part-role');

      await (manager as any).replayHistory('oc-history-part-role', 'server-history-part-role');

      const events = relay.sentEvents as any[];
      const userPrompt = events.find((e: any) => e.payload?.eventType === 'user_prompt');
      const promptAsTaskComplete = events.find(
        (e: any) =>
          e.payload?.eventType === 'task_complete' &&
          e.payload?.data?.summary === 'desktop prompt from part role',
      );

      expect(userPrompt?.payload.data.prompt).toBe('desktop prompt from part role');
      expect(promptAsTaskComplete).toBeUndefined();
    });

    it('does not restore old attached mappings when the current OpenCode API list is empty', async () => {
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

      expect(restoredManager.ownsSession('server-stored')).toBe(false);
      expect(bridge.getAttachedSessionIds()).not.toContain('ses_stored');
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

    it('falls back to local storage when the OpenCode HTTP session endpoint is unavailable', async () => {
      const sessionDir = join(opencodeDataDir, 'storage', 'session', 'global');
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, 'ses_local_offline.json'), JSON.stringify({
        id: 'ses_local_offline',
        directory: 'F:/Work/Codekey',
        title: 'Offline OpenCode title',
        time: { created: 1, updated: 30 },
      }), 'utf-8');
      writeFileSync(join(sessionDir, 'ses_subagent.json'), JSON.stringify({
        id: 'ses_subagent',
        title: '@explore',
        time: { created: 1, updated: 40 },
      }), 'utf-8');
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (url.endsWith('/session')) return { ok: false, json: async () => [] } as unknown as Response;
        return { ok: true, body: null } as Response;
      }));

      await expect(manager.listSessions()).resolves.toMatchObject([
        { id: 'ses_local_offline', title: 'Offline OpenCode title', directory: 'F:/Work/Codekey' },
      ]);
    });
  });

  describe('message.part.updated', () => {
    it('forwards text part content to relay', async () => {
      await registerOCSession(manager, 'oc-session-5', 'server-oc-session-5');
      relay.sent.length = 0;
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

    it('forwards desktop user text parts as user_prompt, not agent task_complete', async () => {
      await registerOCSession(manager, 'oc-session-user-part', 'server-oc-session-user-part');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          message: { role: 'user' },
          part: {
            id: 'part-user-1',
            sessionID: 'oc-session-user-part',
            messageID: 'msg-user-part',
            type: 'text',
            text: '电脑端输入的 prompt',
          },
        },
      });

      const events = relay.sentEvents as any[];
      const userPrompt = events.find(
        (e: any) => e.payload?.eventType === 'user_prompt',
      );
      const promptAsTaskComplete = events.find(
        (e: any) =>
          e.payload?.eventType === 'task_complete' &&
          e.payload?.data?.summary === '电脑端输入的 prompt',
      );

      expect(userPrompt).toBeDefined();
      expect(userPrompt.payload.data.prompt).toBe('电脑端输入的 prompt');
      expect(promptAsTaskComplete).toBeUndefined();

      await (manager as any).handleSSEEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-user-part',
            sessionID: 'oc-session-user-part',
            role: 'user',
            summary: { body: '电脑端输入的 prompt' },
          },
        },
      });

      const userPrompts = (relay.sentEvents as any[]).filter(
        (e: any) => e.payload?.eventType === 'user_prompt',
      );
      expect(userPrompts.length).toBe(1);
    });

    it('deduplicates same part ID', async () => {
      await registerOCSession(manager, 'oc-session-6', 'server-oc-session-6');
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
      await registerOCSession(manager, 'oc-session-7', 'server-oc-session-7');
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
      await registerOCSession(manager, 'oc-session-7e', 'server-oc-session-7e');
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

    it('does NOT forward session.idle events for subagent sessions', async () => {
      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      // Simulate a registered subagent session with a relay mapping
      subagentSet.add('oc-subagent-idle');
      (manager as any).opencodeSessionToRelayId.set('oc-subagent-idle', 'server-oc-subagent-idle');
      (manager as any).opencodeSessions.add('server-oc-subagent-idle');

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'session.idle',
        properties: {
          sessionID: 'oc-subagent-idle',
        },
      });

      const events = relay.sentEvents as any[];
      const taskComplete = events.find(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskComplete).toBeUndefined();
    });

    it('does NOT forward session.error events for subagent sessions', async () => {
      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      subagentSet.add('oc-subagent-error');
      (manager as any).opencodeSessionToRelayId.set('oc-subagent-error', 'server-oc-subagent-error');
      (manager as any).opencodeSessions.add('server-oc-subagent-error');

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'session.error',
        properties: {
          sessionID: 'oc-subagent-error',
          error: { message: 'Subagent failed' },
        },
      });

      const events = relay.sentEvents as any[];
      const errorEvent = events.find(
        (e: any) => e.payload?.eventType === 'error',
      );
      expect(errorEvent).toBeUndefined();
    });
  });

  describe('message.part.updated — phone-sent text echo', () => {
    it('does NOT forward the echoed phone prompt as agent text', async () => {
      // Register session mapping.
      await registerOCSession(manager, 'oc-session-echo', 'server-oc-session-echo');
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
      await registerOCSession(manager, 'oc-session-genuine', 'server-oc-session-genuine');
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
      await registerOCSession(manager, 'oc-session-multi', 'server-oc-session-multi');
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

    it('does NOT forward text part events for subagent sessions with mapped relay IDs', async () => {
      // A subagent that somehow has a relay mapping must still not leak events.
      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      subagentSet.add('oc-subagent-part');
      (manager as any).opencodeSessionToRelayId.set('oc-subagent-part', 'server-oc-subagent-part');
      (manager as any).opencodeSessions.add('server-oc-subagent-part');

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-subagent-1',
            sessionID: 'oc-subagent-part',
            messageID: 'msg-subagent',
            type: 'text',
            text: 'subagent reply text',
          },
        },
      });

      const events = relay.sentEvents as any[];
      const taskComplete = events.find(
        (e: any) => e.payload?.eventType === 'task_complete',
      );
      expect(taskComplete).toBeUndefined();
    });

    it('does NOT forward message.updated events for subagent sessions', async () => {
      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      subagentSet.add('oc-subagent-msg');
      (manager as any).opencodeSessionToRelayId.set('oc-subagent-msg', 'server-oc-subagent-msg');
      (manager as any).opencodeSessions.add('server-oc-subagent-msg');

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-subagent',
            sessionID: 'oc-subagent-msg',
            role: 'user',
            summary: { body: 'user text from subagent' },
          },
        },
      });

      const events = relay.sentEvents as any[];
      const userPrompt = events.find(
        (e: any) => e.payload?.eventType === 'user_prompt',
      );
      expect(userPrompt).toBeUndefined();
    });
  });

  describe('handleCommand', () => {
    it('emits command_started for phone-originated prompts before posting to OpenCode', async () => {
      vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true } as Response)));
      (manager as any).opencodeSessionToRelayId.set('oc-session-command', 'server-oc-session-command');
      (manager as any).opencodeSessions.add('server-oc-session-command');

      await manager.handleCommand('server-oc-session-command', '继续分析这个问题', 'oc-session-command');

      const events = relay.sentEvents as any[];
      const userPrompt = events.find((e: any) => e.payload?.eventType === 'user_prompt');
      const started = events.find((e: any) => e.payload?.eventType === 'command_started');

      expect(userPrompt).toBeDefined();
      expect(started).toBeDefined();
      expect(started.payload.sessionId).toBe('server-oc-session-command');
      // Audit r2 P0-A: command_started is a status event — body stripped, not echoed.
      expect(started.payload.data).toEqual({
        type: 'command_started',
        safe_summary: 'Command sent',
        preview_label: 'command_started',
      });
      expect(started.payload.data).not.toHaveProperty('command');
      expect((globalThis.fetch as any)).toHaveBeenCalledWith(
        'http://127.0.0.1:4096/session/oc-session-command/prompt_async',
        expect.objectContaining({ method: 'POST' }),
      );
    });
  });

  describe('message.part.updated — streaming agent response', () => {
    // Regression guard: the agent's actual text response was being
    // dropped because the partID was added to the dedup set on the
    // first event (text="") and the second event (the real text) was
    // suppressed by the same dedup key. Phone only saw the generic
    // "Session idle" task_complete with no summary.

    it('forwards the real text when the first text-part event is empty', async () => {
      await registerOCSession(manager, 'oc-session-stream-empty', 'server-oc-session-stream-empty');
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
      await registerOCSession(manager, 'oc-session-stream-chunks', 'server-oc-session-stream-chunks');
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
      await registerOCSession(manager, 'oc-session-dup-text', 'server-oc-session-dup-text');
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

    it('does NOT auto-register subagent sessions for input_required parts', async () => {
      // Subagent sessions must not auto-register via ensureRelaySession
      // even for input_required events.
      const subagentSet = (manager as any)._subagentSessions as Set<string>;
      subagentSet.add('oc-subagent-input');

      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-subagent-input',
            sessionID: 'oc-subagent-input',
            messageID: 'msg-subagent-input',
            type: 'text',
            text: '',
            input: { schema: { type: 'object' } },
            input_required: true,
          },
        },
      });

      await new Promise(r => setTimeout(r, 50));

      // Should NOT have registered at the relay
      expect(manager.ownsSession('server-oc-subagent-input')).toBe(false);
      // Should NOT have generated any register_session messages
      const registrations = relay.sent
        .map((raw) => JSON.parse(raw))
        .filter((msg) => msg.type === 'register_session' && msg.payload.claudeSessionId === 'oc-subagent-input');
      expect(registrations.length).toBe(0);
    });
  });

  describe('input_required from message.part.updated with options', () => {
    it('creates input_required card when part.input has options', async () => {
      await registerOCSession(manager, 'oc-session-oc-options', 'server-oc-session-oc-options');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      // OpenCode shows option card via message.part.updated with input.options
      await (manager as any).handleSSEEvent({
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'part-oc-options',
            sessionID: 'oc-session-oc-options',
            messageID: 'msg-oc-options',
            type: 'text',
            text: '',
            input_required: true,
            input: {
              question: '请选择下一步操作',
              options: [
                { label: '继续分析', value: 'continue' },
                { label: '换一种方案', value: 'change' },
                { label: '自定义输入', value: 'custom' },
              ],
            },
          },
        },
      });

      await new Promise(r => setTimeout(r, 20));

      const events = relay.sentEvents as any[];
      const inputCard = events.find((e: any) => e.payload?.eventType === 'input_required');
      expect(inputCard, `no input_required card found in: ${JSON.stringify(relay.sent)}`).toBeDefined();
      const data = inputCard.payload.data;
      expect(data.type).toBe('input_required');
      expect(data.questions).toHaveLength(1);
      expect(data.questions[0].options).toHaveLength(3);
      expect(data.questions[0].options[0].label).toBe('继续分析');
    });

    it('creates input_required card when part.params has options (tool_use format)', async () => {
      await registerOCSession(manager, 'oc-session-oc-tool', 'server-oc-session-oc-tool');
      relay.sent.length = 0;
      relay.sentEvents.length = 0;

      await (manager as any).handleSSEEvent({
        type: 'message.updated',
        properties: {
          info: {
            id: 'msg-oc-tool',
            sessionID: 'oc-session-oc-tool',
            role: 'assistant',
            params: {
              question: 'What next?',
              options: ['1: Continue', '2: Change approach', '3: Custom'],
            },
          },
        },
      });

      await new Promise(r => setTimeout(r, 20));

      const events = relay.sentEvents as any[];
      const inputCard = events.find((e: any) => e.payload?.eventType === 'input_required');
      expect(inputCard, `no input_required card for tool_use format`).toBeDefined();
      expect(inputCard.payload.data.questions[0].options).toHaveLength(3);
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
    it('does not restore attached sessions when the current OpenCode session list omits them', async () => {
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

        expect(bridge.getAttachedSessionIds()).not.toContain('ses_local_a');
        expect(manager.ownsSession('server-ses_local_a')).toBe(false);
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

        // Now fetches /session to pre-populate _subagentSessions
        expect(fetchSpy).toHaveBeenCalled();
        // But no register_session events should have been generated
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

    it('pre-populates subagent session IDs from HTTP /session on server.connected', async () => {
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = async (input: string | URL | Request) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/session')) {
            return {
              ok: true,
              json: async () => [
                { id: 'normal-session-1', title: 'My task' },
                { id: 'subagent-by-type', type: 'subagent', title: 'explore' },
                { id: 'subagent-by-flag', subagent: true, title: 'general' },
                { id: 'at-prefix-sub', title: '@explore codebase' },
              ],
            } as Response;
          }
          return { ok: true, body: null } as Response;
        };

        await (manager as any).handleSSEEvent({ type: 'server.connected', properties: {} });
        await new Promise(r => setTimeout(r, 50));

        const subagentSet = (manager as any)._subagentSessions as Set<string>;
        expect(subagentSet.has('normal-session-1')).toBe(false);
        expect(subagentSet.has('subagent-by-type')).toBe(true);
        expect(subagentSet.has('subagent-by-flag')).toBe(true);
        expect(subagentSet.has('at-prefix-sub')).toBe(false); // Title-based detection is run-time only
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });
});
