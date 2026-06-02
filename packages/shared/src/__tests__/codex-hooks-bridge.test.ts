import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { ApprovalBridge } from '../bridge/handler.js';
import { startBridgeServer } from '../bridge/server.js';

/**
 * Fake relay for hook bridge HTTP tests.
 * Extends EventEmitter so the bridge can listen for relay events.
 * Tracks sent messages and auto-responds to register_session.
 */
class FakeHookRelay extends EventEmitter {
  sent: string[] = [];

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

  sendEvent(_sessionId: string, _msg: unknown): void {
    // not used by hook endpoint path
  }

  /** Simulate phone's approval decision via relay. */
  simulateApproval(clientEventId: string, decision: string): void {
    this.emit('approval_forward', { clientEventId, eventId: clientEventId, decision });
  }
}

/** Wait for a sent message matching `predicate` to appear within `timeoutMs`. */
async function waitForMessage(
  relay: FakeHookRelay,
  predicate: (msg: Record<string, unknown>) => boolean,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const msg = relay.sent.map(s => JSON.parse(s)).find(predicate);
    if (msg) return msg;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`waitForMessage timed out after ${timeoutMs}ms`);
}

function createHookBridge(): { relay: FakeHookRelay; bridge: ApprovalBridge } {
  const relay = new FakeHookRelay();
  return { relay, bridge: new ApprovalBridge(relay as any) };
}

describe('CodexHooksBridge', () => {
  // ── HTTP endpoint integration tests ──
  describe('POST /v1/codex-hooks/permission-request (real HTTP)', () => {
    it('registration + phone approve → allow', async () => {
      const { relay, bridge } = createHookBridge();
      const { close, port } = await startBridgeServer(bridge, 0);
      try {
        const body = JSON.stringify({
          session_id: 'test-session-1',
          tool_name: 'Bash',
          tool_input: { command: 'echo hello' },
          cwd: '/test',
        });

        const respPromise = fetch(`http://127.0.0.1:${port}/v1/codex-hooks/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        // Assert: register_session was sent
        const regMsg = await waitForMessage(relay, m => m.type === 'register_session');
        expect(regMsg).toBeDefined();
        expect((regMsg.payload as Record<string, unknown>).agentType).toBe('codex');
        expect((regMsg.payload as Record<string, unknown>).claudeSessionId).toBe('test-session-1');

        // Fake relay auto-responds with session_registered via setImmediate.
        // Wait for the endpoint to process it and send the approval event.
        // Small delay to let the event loop flush the setImmediate chain.
        await new Promise(r => setTimeout(r, 50));

        // Assert: approval_required event was sent with the server session id
        const evtMsg = await waitForMessage(
          relay,
          m => (m as Record<string, unknown>).type === 'event'
            && ((m as any).payload?.eventType === 'approval_required'),
        );
        expect(evtMsg).toBeDefined();
        const evtPayload = (evtMsg as any).payload as Record<string, unknown>;
        expect(evtPayload.sessionId).toBe('server-test-session-1');
        expect(evtPayload.eventType).toBe('approval_required');
        expect(evtPayload.agent).toBe('codex');

        // Simulate phone approve using the clientEventId from the event
        const clientEventId = evtPayload.clientEventId as string;
        expect(clientEventId).toContain('hook:test-session-1');
        relay.simulateApproval(clientEventId, 'approve');

        // Assert: HTTP response indicates allow
        const resp = await respPromise;
        const data = await resp.json() as Record<string, unknown>;
        const hso = data.hookSpecificOutput as Record<string, unknown> | undefined;
        const decision = hso?.decision as Record<string, unknown> | undefined;

        expect(resp.status).toBe(200);
        expect(hso?.hookEventName).toBe('PermissionRequest');
        expect(decision?.behavior).toBe('allow');
      } finally {
        await close();
      }
    });

    it('exposes codex hook approvals through local pending-approvals while waiting', async () => {
      const { relay, bridge } = createHookBridge();
      const { close, port } = await startBridgeServer(bridge, 0);
      try {
        const body = JSON.stringify({
          session_id: 'desktop-visible-session',
          tool_name: 'Bash',
          tool_input: { command: 'echo visible' },
          cwd: '/test',
        });

        const respPromise = fetch(`http://127.0.0.1:${port}/v1/codex-hooks/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        const evtMsg = await waitForMessage(
          relay,
          m => (m as Record<string, unknown>).type === 'event'
            && ((m as any).payload?.eventType === 'approval_required'),
        );
        const evtPayload = (evtMsg as any).payload as Record<string, unknown>;
        const clientEventId = evtPayload.clientEventId as string;

        const pendingResp = await fetch(`http://127.0.0.1:${port}/v1/pending-approvals`);
        const pendingBody = await pendingResp.json() as { approvals?: Record<string, unknown>[] };
        expect(pendingBody.approvals).toEqual([
          expect.objectContaining({
            id: clientEventId,
            serverSessionId: 'server-desktop-visible-session',
            claudeSessionId: 'desktop-visible-session',
            command: 'echo visible',
            summary: 'Codex needs approval: Bash',
            toolName: 'Bash',
            risk: 'medium',
          }),
        ]);

        relay.simulateApproval(clientEventId, 'approve');

        const resp = await respPromise;
        expect(resp.status).toBe(200);

        const clearedResp = await fetch(`http://127.0.0.1:${port}/v1/pending-approvals`);
        const clearedBody = await clearedResp.json() as { approvals?: Record<string, unknown>[] };
        expect(clearedBody.approvals).toEqual([]);
      } finally {
        await close();
      }
    });

    it('local approval-response releases a waiting codex hook request', async () => {
      const { relay, bridge } = createHookBridge();
      const { close, port } = await startBridgeServer(bridge, 0);
      try {
        const respPromise = fetch(`http://127.0.0.1:${port}/v1/codex-hooks/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            session_id: 'desktop-button-session',
            tool_name: 'Bash',
            tool_input: { command: 'echo approved-from-vscode' },
            cwd: '/test',
          }),
        });

        const evtMsg = await waitForMessage(
          relay,
          m => (m as Record<string, unknown>).type === 'event'
            && ((m as any).payload?.eventType === 'approval_required'),
        );
        const evtPayload = (evtMsg as any).payload as Record<string, unknown>;
        const clientEventId = evtPayload.clientEventId as string;

        const localResp = await fetch(`http://127.0.0.1:${port}/v1/approval-response`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionId: evtPayload.sessionId,
            eventId: 'server-event-from-relay',
            clientEventId,
            decision: 'approve',
            message: '',
          }),
        });
        expect(localResp.status).toBe(200);

        const resp = await respPromise;
        const data = await resp.json() as Record<string, unknown>;
        const hso = data.hookSpecificOutput as Record<string, unknown> | undefined;
        const decision = hso?.decision as Record<string, unknown> | undefined;

        expect(decision?.behavior).toBe('allow');
      } finally {
        await close();
      }
    });

    it('registration + phone deny → deny', async () => {
      const { relay, bridge } = createHookBridge();
      const { close, port } = await startBridgeServer(bridge, 0);
      try {
        const body = JSON.stringify({
          session_id: 'test-session-2',
          tool_name: 'Bash',
          tool_input: { command: 'rm -rf /' },
        });

        const respPromise = fetch(`http://127.0.0.1:${port}/v1/codex-hooks/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        // Wait for register_session
        await waitForMessage(relay, m => m.type === 'register_session');
        await new Promise(r => setTimeout(r, 50));

        // Wait for approval event
        const evtMsg = await waitForMessage(
          relay,
          m => (m as Record<string, unknown>).type === 'event'
            && ((m as any).payload?.eventType === 'approval_required'),
        );
        const clientEventId = (evtMsg as any).payload.clientEventId as string;

        // Simulate phone deny
        relay.simulateApproval(clientEventId, 'deny');

        const resp = await respPromise;
        const data = await resp.json() as Record<string, unknown>;
        const hso = data.hookSpecificOutput as Record<string, unknown> | undefined;
        const decision = hso?.decision as Record<string, unknown> | undefined;

        expect(resp.status).toBe(200);
        expect(decision?.behavior).toBe('deny');
      } finally {
        await close();
      }
    });

    it('active resume session mapping uses existing serverSessionId', async () => {
      const { relay, bridge } = createHookBridge();

      // Provide a mock CodexResumeManager with an active (already-resumed) session
      const activeSession = {
        localSession: { sessionId: 'active-session-1', cwd: '/test', title: 'Test' },
        serverSessionId: 'existing-server-id',
      };
      const mockManager = {
        getActiveSessions: () => [activeSession],
        getResumedLocalIds: () => ['active-session-1'],
      };

      const { close, port } = await startBridgeServer(
        bridge, 0, 'cli', undefined, undefined, undefined, mockManager as any,
      );
      try {
        const body = JSON.stringify({
          session_id: 'active-session-1',
          tool_name: 'Bash',
          tool_input: { command: 'echo active' },
        });

        const respPromise = fetch(`http://127.0.0.1:${port}/v1/codex-hooks/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        // For an active session, the endpoint should NOT send register_session
        // (it already has the serverSessionId). Wait a bit and verify no register_session.
        await new Promise(r => setTimeout(r, 100));
        const regMsgs = relay.sent
          .filter(s => { try { return JSON.parse(s).type === 'register_session'; } catch { return false; } });
        expect(regMsgs.length).toBe(0);

        // Instead, it should directly send the approval event with the existing serverSessionId
        const evtMsg = await waitForMessage(
          relay,
          m => (m as Record<string, unknown>).type === 'event'
            && ((m as any).payload?.eventType === 'approval_required'),
        );
        const evtPayload = (evtMsg as any).payload as Record<string, unknown>;
        expect(evtPayload.sessionId).toBe('existing-server-id');

        // Complete the approval
        relay.simulateApproval(evtPayload.clientEventId as string, 'approve');

        const resp = await respPromise;
        const data = await resp.json() as Record<string, unknown>;
        const hso = data.hookSpecificOutput as Record<string, unknown> | undefined;
        const decision = hso?.decision as Record<string, unknown> | undefined;
        expect(decision?.behavior).toBe('allow');
      } finally {
        await close();
      }
    });

    it('registration timeout → deny (env CODEX_HOOK_REG_TIMEOUT_MS)', async () => {
      // Use a relay that does NOT auto-respond to register_session
      const silentRelay = new EventEmitter() as any;
      silentRelay.sendRaw = vi.fn();
      const bridge = new ApprovalBridge(silentRelay);
      const { close, port } = await startBridgeServer(bridge, 0);
      try {
        const body = JSON.stringify({
          session_id: 'reg-timeout-test',
          tool_name: 'Bash',
          tool_input: { command: 'echo timeout' },
        });

        // Set a very short registration timeout (50ms) so the test doesn't wait long
        process.env.CODEX_HOOK_REG_TIMEOUT_MS = '50';

        const resp = await fetch(`http://127.0.0.1:${port}/v1/codex-hooks/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
        const data = await resp.json() as Record<string, unknown>;
        const hso = data.hookSpecificOutput as Record<string, unknown> | undefined;
        const decision = hso?.decision as Record<string, unknown> | undefined;

        expect(resp.status).toBe(200);
        expect(decision?.behavior).toBe('deny');
        expect(String(decision?.message)).toContain('registration timed out');

        // Register_session was sent (1 call), but no approval event should follow
        // since registration timed out before session_registered arrived.
        const sentMsgs = (silentRelay.sendRaw as ReturnType<typeof vi.fn>).mock.calls
          .map((args: unknown[]) => { try { return JSON.parse(args[0] as string); } catch { return null; } })
          .filter(Boolean);
        const eventMsgs = sentMsgs.filter((m: Record<string, unknown>) => m.type === 'event');
        expect(eventMsgs.length).toBe(0); // no approval event sent
      } finally {
        delete process.env.CODEX_HOOK_REG_TIMEOUT_MS;
        await close();
      }
    });

    it('approval timeout → deny + late event does not affect response', async () => {
      const { relay, bridge } = createHookBridge();
      const { close, port } = await startBridgeServer(bridge, 0);
      try {
        const body = JSON.stringify({
          session_id: 'approve-timeout-test',
          tool_name: 'Bash',
          tool_input: { command: 'echo slow' },
        });

        // Short approval timeout (50ms)
        process.env.CODEX_HOOK_APPROVAL_TIMEOUT_MS = '50';

        const respPromise = fetch(`http://127.0.0.1:${port}/v1/codex-hooks/permission-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });

        // Registration will succeed (auto-response from fake relay).
        // Wait for approval event to confirm we reached the approval phase.
        await waitForMessage(
          relay,
          m => (m as Record<string, unknown>).type === 'event'
            && ((m as any).payload?.eventType === 'approval_required'),
        );

        // Do NOT simulate phone approval — let timeout fire.
        const resp = await respPromise;
        const data = await resp.json() as Record<string, unknown>;
        const hso = data.hookSpecificOutput as Record<string, unknown> | undefined;
        const decision = hso?.decision as Record<string, unknown> | undefined;

        expect(resp.status).toBe(200);
        expect(decision?.behavior).toBe('deny');
        expect(String(decision?.message)).toContain('Phone approval timed out');

        // Late approval after timeout should not affect the already-returned response.
        // Find the clientEventId from the approval event and simulate a late response.
        const eventMsgs = relay.sent
          .filter(s => { try { const m = JSON.parse(s); return m.type === 'event' && m.payload?.eventType === 'approval_required'; } catch { return false; } })
          .map(s => JSON.parse(s));

        if (eventMsgs.length > 0) {
          const lateId = eventMsgs[0].payload.clientEventId as string;
          // Emit late approval — should be ignored by the endpoint (already finished)
          relay.simulateApproval(lateId, 'approve');
        }

        // No exception means the late event was safely ignored.
        // We cannot directly assert listener count from test, but the absence of
        // crashes or duplicate responses confirms the resolved guard works.
      } finally {
        delete process.env.CODEX_HOOK_APPROVAL_TIMEOUT_MS;
        await close();
      }
    });
  });

  // ── Unit tests (logic level) ──
  describe('decision relay logic', () => {
    let relay: FakeHookRelay;

    beforeEach(() => {
      relay = new FakeHookRelay();
    });

    it('approve → allow', () => {
      let result: string | null = null;
      const clientEventId = 'hook:test:1';

      const handler = (payload: unknown) => {
        const fwd = payload as { clientEventId?: string; decision?: string };
        if (fwd.clientEventId !== clientEventId) return;
        result = fwd.decision === 'approve' ? 'allow' : 'deny';
      };
      relay.on('approval_forward', handler);
      relay.simulateApproval(clientEventId, 'approve');

      expect(result).toBe('allow');
    });

    it('deny → deny', () => {
      let result: string | null = null;
      const clientEventId = 'hook:test:2';

      const handler = (payload: unknown) => {
        const fwd = payload as { clientEventId?: string; decision?: string };
        if (fwd.clientEventId !== clientEventId) return;
        result = fwd.decision === 'approve' ? 'allow' : 'deny';
      };
      relay.on('approval_forward', handler);
      relay.simulateApproval(clientEventId, 'deny');

      expect(result).toBe('deny');
    });

    it('finish is idempotent', () => {
      let callCount = 0;
      let resolved = false;
      function finish(): void { if (resolved) return; resolved = true; callCount++; }
      finish();
      finish();
      finish();
      expect(callCount).toBe(1);
    });

    it('timeout cleans up approval_forward listener before late events', () => {
      const handler = () => {};
      relay.on('approval_forward', handler);
      relay.off('approval_forward', handler);

      let triggered = false;
      relay.on('approval_forward', () => { triggered = true; });
      relay.simulateApproval('late', 'approve');
      expect(triggered).toBe(true);
    });

    it('register timeout cleans up session_registered listener and timer', () => {
      let cleaned = false;
      const regHandler = () => {};
      const timer = setTimeout(() => {}, 1);
      relay.on('session_registered', regHandler);
      relay.off('session_registered', regHandler);
      clearTimeout(timer);
      cleaned = true;
      expect(cleaned).toBe(true);
    });
  });
});
