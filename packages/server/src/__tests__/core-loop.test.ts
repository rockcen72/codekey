import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';

// Simulation involves multiple WS connections and HTTP roundtrips over SSH tunnel
const TEST_TIMEOUT = 30000;
import WebSocket from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import { buildApp } from '../app.js';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

function connectWs(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
    ws.on('close', () => reject(new Error('WebSocket closed during connect')));
  });
}

function waitForMessage(ws: WebSocket, expectedType: string, timeout = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${expectedType}" after ${timeout}ms`)), timeout);
    const handler = (raw: Buffer) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === expectedType) {
          clearTimeout(timer);
          ws.removeListener('message', handler);
          resolve(msg.payload ?? msg);
        }
      } catch { /* skip malformed */ }
    };
    ws.on('message', handler);
    ws.on('close', function onClose() {
      clearTimeout(timer);
      ws.removeListener('message', handler);
      reject(new Error(`WebSocket closed before receiving "${expectedType}"`));
    });
  });
}

describeDb('Core loop simulation', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let sql: Awaited<ReturnType<typeof buildApp>>['sql'];
  let port: number;
  let baseUrl: string;
  let wsBaseUrl: string;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    const built = await buildApp(DATABASE_URL!);
    app = built.app;
    sql = built.sql;
    const address = await app.listen({ port: 0, host: '127.0.0.1' });
    port = parseInt(new URL(address).port, 10);
    baseUrl = `http://127.0.0.1:${port}`;
    wsBaseUrl = `ws://127.0.0.1:${port}`;
  }, TEST_TIMEOUT);

  // Reset rate-limit counter before each test (devices.test leaves 3 used slots)
  beforeEach(async () => {
    await sql`DELETE FROM pairing_codes WHERE ip_address IN ('127.0.0.1', '::1')`;
  });

  afterAll(async () => {
    // Cleanup test data
    for (const did of cleanupIds) {
      try { await sql`DELETE FROM approvals WHERE session_id IN (SELECT id FROM sessions WHERE device_id = ${did})`; } catch { /* ignore */ }
      try { await sql`DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE device_id = ${did})`; } catch { /* ignore */ }
      try { await sql`DELETE FROM sessions WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM device_tokens WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM pairing_codes WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM devices WHERE id = ${did}`; } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  it('full pair -> confirm -> WS auth -> session -> event -> approval -> forward', async () => {
    // -- 1. PC initiates pairing --
    const deviceSecret = randomBytes(32).toString('hex');
    const deviceSecretHash = createHash('sha256').update(deviceSecret).digest('hex');

    const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecretHash, deviceName: 'test-pc' }),
    });
    expect(pairRes.status).toBe(200);
    const pairBody = await pairRes.json() as { code: string; deviceId: string };
    expect(pairBody.code).toHaveLength(8);
    expect(pairBody.deviceId).toBeDefined();
    cleanupIds.push(pairBody.deviceId);

    // -- 2. PC opens pairing WS --
    const pairingWs = await connectWs(`${wsBaseUrl}/ws?device_id=${pairBody.deviceId}&device_secret=${deviceSecret}`);
    await waitForMessage(pairingWs, 'pairing_ready');

    // -- 3. Mini Program confirms pairing --
    // Start listening for device_token BEFORE confirm to avoid race
    const deviceTokenPromise = waitForMessage(pairingWs, 'device_token', 20000);
    const confirmRes = await fetch(`${baseUrl}/api/v1/devices/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pairBody.code }),
    });
    expect(confirmRes.status).toBe(200);
    const confirmBody = await confirmRes.json() as { clientToken: string };
    expect(confirmBody.clientToken).toBeDefined();

    // -- 4. PC receives device_token on pairing WS --
    const tokenMsg = await deviceTokenPromise;
    const deviceToken: string = tokenMsg.deviceToken;
    expect(deviceToken).toBeDefined();
    pairingWs.close();

    // -- 5. PC opens runtime WS and registers session --
    const pcWs = await connectWs(`${wsBaseUrl}/ws?device_id=${pairBody.deviceId}&token=${deviceToken}`);
    pcWs.send(JSON.stringify({
      type: 'register_session',
      payload: { agentType: 'claude-code' },
    }));
    const regMsg = await waitForMessage(pcWs, 'session_registered');
    const sessionId: string = regMsg.sessionId;
    expect(sessionId).toBeDefined();

    // -- 6. Mini Program opens client WS (before event, to receive event_push) --
    const mpWs = await connectWs(`${wsBaseUrl}/ws?device_id=${pairBody.deviceId}&token=${confirmBody.clientToken}`);

    // -- 7. PC sends an approval_required event --
    pcWs.send(JSON.stringify({
      type: 'event',
      payload: {
        clientEventId: 'test-evt-1',
        sessionId,
        agent: 'claude-code',
        eventType: 'approval_required',
        data: { type: 'approval_required', command: 'echo hello', risk: 'low', summary: 'Test event' },
        ts: new Date().toISOString(),
      },
    }));

    // PC receives event_ack with server-generated event ID
    const eventAck = await waitForMessage(pcWs, 'event_ack');
    expect(eventAck.serverEventId).toBeDefined();
    expect(eventAck.clientEventId).toBe('test-evt-1');
    const serverEventId: string = eventAck.serverEventId;

    // -- 8. Mini Program receives event_push --
    const eventPush = await waitForMessage(mpWs, 'event_push');
    expect(eventPush.eventId).toBe(serverEventId);
    expect(eventPush.eventType).toBe('approval_required');

    // -- 9. Mini Program sends approve --
    mpWs.send(JSON.stringify({
      type: 'approval_response',
      payload: { sessionId, eventId: serverEventId, decision: 'approve', message: '' },
    }));

    // -- 10. PC receives approval_forward --
    const approvalForward = await waitForMessage(pcWs, 'approval_forward');
    expect(approvalForward.eventId).toBe(serverEventId);
    expect(approvalForward.decision).toBe('approve');

    // -- 11. Verify DB state via REST (authenticated) --
    // Check event is no longer pending
    const evtRes = await fetch(`${baseUrl}/api/v1/sessions/${sessionId}/events`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(evtRes.status).toBe(200);
    const events = await evtRes.json() as any[];
    const evt = events.find((e: any) => e.id === serverEventId);
    expect(evt).toBeDefined();
    expect(evt.pending).toBe(false);
    expect(evt.decision).toBe('approve');

    // Check approval log
    const auditRes = await fetch(`${baseUrl}/api/v1/audit`, {
      headers: { Authorization: `Bearer ${deviceToken}` },
    });
    expect(auditRes.status).toBe(200);
    const approvals = await auditRes.json() as any[];
    const match = approvals.find((a: any) => a.event_id === serverEventId);
    expect(match).toBeDefined();
    expect(match.decision).toBe('approve');

    mpWs.close();
    pcWs.close();
  }, TEST_TIMEOUT);

  it('rejects approve for high-risk event', async () => {
    // Quick bootstrap
    const secret = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(secret).digest('hex');
    const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecretHash: hash, deviceName: 'test-risk' }),
    });
    const pair = await pairRes.json() as { code: string; deviceId: string };
    cleanupIds.push(pair.deviceId);

    const pws = await connectWs(`${wsBaseUrl}/ws?device_id=${pair.deviceId}&device_secret=${secret}`);
    await waitForMessage(pws, 'pairing_ready');

    // Start listening for device_token BEFORE confirm to avoid race
    const deviceTokenPromise = waitForMessage(pws, 'device_token', 20000);
    const confirmRes = await fetch(`${baseUrl}/api/v1/devices/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pair.code }),
    });
    const confirm = await confirmRes.json() as { clientToken: string };
    const tokenMsg = await deviceTokenPromise;
    pws.close();

    const pcWs = await connectWs(`${wsBaseUrl}/ws?device_id=${pair.deviceId}&token=${tokenMsg.deviceToken}`);
    pcWs.send(JSON.stringify({ type: 'register_session', payload: { agentType: 'claude-code' } }));
    const reg = await waitForMessage(pcWs, 'session_registered');

    const mpWs = await connectWs(`${wsBaseUrl}/ws?device_id=${pair.deviceId}&token=${confirm.clientToken}`);

    // Send high-risk event
    pcWs.send(JSON.stringify({
      type: 'event',
      payload: {
        clientEventId: 'risk-evt-1',
        sessionId: reg.sessionId,
        agent: 'claude-code',
        eventType: 'approval_required',
        data: { type: 'approval_required', command: 'rm -rf /', risk: 'high', summary: 'High risk test' },
        ts: new Date().toISOString(),
      },
    }));

    const ack = await waitForMessage(pcWs, 'event_ack');
    const push = await waitForMessage(mpWs, 'event_push');

    // Attempt to approve high-risk event -- should fail
    mpWs.send(JSON.stringify({
      type: 'approval_response',
      payload: { sessionId: reg.sessionId, eventId: ack.serverEventId, decision: 'approve', message: '' },
    }));

    // MP should receive error
    const mpError = await waitForMessage(mpWs, 'error');
    expect(mpError.code).toBe('RISK_TOO_HIGH');

    // PC should NOT receive approval_forward for high-risk event
    const noForward = new Promise<void>((resolve, reject) => {
      const handler = (raw: Buffer) => {
        try {
          const msg = JSON.parse(raw.toString());
          if (msg.type === 'approval_forward') {
            clearTimeout(timer);
            pcWs.removeListener('message', handler);
            reject(new Error('PC received unexpected approval_forward for high-risk event'));
          }
        } catch { /* skip malformed */ }
      };
      const timer = setTimeout(() => {
        pcWs.removeListener('message', handler);
        resolve();
      }, 800);
      pcWs.on('message', handler);
    });
    await noForward;

    // Verify event is still pending in DB
    const evtRes = await fetch(`${baseUrl}/api/v1/sessions/${reg.sessionId}/events`, {
      headers: { Authorization: `Bearer ${tokenMsg.deviceToken}` },
    });
    const events = await evtRes.json() as any[];
    const evt = events.find((e: any) => e.id === ack.serverEventId);
    expect(evt.pending).toBe(true);

    mpWs.close();
    pcWs.close();
  }, TEST_TIMEOUT);

  it('only one concurrent approval wins for same event', async () => {
    // Bootstrap device
    const secret = randomBytes(32).toString('hex');
    const hash = createHash('sha256').update(secret).digest('hex');
    const pairRes = await fetch(`${baseUrl}/api/v1/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceSecretHash: hash, deviceName: 'test-concur' }),
    });
    const pair = await pairRes.json() as { code: string; deviceId: string };
    cleanupIds.push(pair.deviceId);

    const pws = await connectWs(`${wsBaseUrl}/ws?device_id=${pair.deviceId}&device_secret=${secret}`);
    await waitForMessage(pws, 'pairing_ready');

    const deviceTokenPromise = waitForMessage(pws, 'device_token', 20000);
    const confirmRes = await fetch(`${baseUrl}/api/v1/devices/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: pair.code }),
    });
    const confirmBody = await confirmRes.json() as { clientToken: string };
    const tokenMsg = await deviceTokenPromise;
    pws.close();

    // PC daemon
    const pcWs = await connectWs(`${wsBaseUrl}/ws?device_id=${pair.deviceId}&token=${tokenMsg.deviceToken}`);
    pcWs.send(JSON.stringify({ type: 'register_session', payload: { agentType: 'claude-code' } }));
    const reg = await waitForMessage(pcWs, 'session_registered');

    // Two MPs, both connected with clientToken
    const mp1 = await connectWs(`${wsBaseUrl}/ws?device_id=${pair.deviceId}&token=${confirmBody.clientToken}`);
    const mp2 = await connectWs(`${wsBaseUrl}/ws?device_id=${pair.deviceId}&token=${confirmBody.clientToken}`);

    // PC sends event
    pcWs.send(JSON.stringify({
      type: 'event',
      payload: {
        clientEventId: 'concur-evt-1',
        sessionId: reg.sessionId,
        agent: 'claude-code',
        eventType: 'approval_required',
        data: { type: 'approval_required', command: 'echo concur', risk: 'low', summary: 'Concurrent test' },
        ts: new Date().toISOString(),
      },
    }));

    const ack = await waitForMessage(pcWs, 'event_ack');

    // Both MPs receive event_push
    await waitForMessage(mp1, 'event_push');
    await waitForMessage(mp2, 'event_push');

    // Register listeners BEFORE sending to eliminate any WS race
    const errPromise = Promise.race([
      waitForMessage(mp1, 'error', 5000),
      waitForMessage(mp2, 'error', 5000),
    ]);
    const forwardPromise = waitForMessage(pcWs, 'approval_forward');

    // Send both approvals back-to-back (no await between sends) so the server
    // processes both pre-checks before either UPDATE -- testing atomic claim
    const approvalPayload = {
      type: 'approval_response',
      payload: { sessionId: reg.sessionId, eventId: ack.serverEventId, decision: 'approve', message: '' },
    };
    mp1.send(JSON.stringify(approvalPayload));
    mp2.send(JSON.stringify(approvalPayload));

    // pcWs receives exactly one approval_forward
    const forward = await forwardPromise;
    expect(forward.eventId).toBe(ack.serverEventId);

    // At least one MP gets error ALREADY_RESPONDED
    const err = await errPromise;
    expect(err.code).toBe('ALREADY_RESPONDED');

    // DB has exactly one approval for this event
    const auditRes = await fetch(`${baseUrl}/api/v1/audit`, {
      headers: { Authorization: `Bearer ${tokenMsg.deviceToken}` },
    });
    const approvals = await auditRes.json() as any[];
    const matches = approvals.filter((a: any) => a.event_id === ack.serverEventId);
    expect(matches).toHaveLength(1);
    expect(matches[0].decision).toBe('approve');

    mp1.close();
    mp2.close();
    pcWs.close();
  }, TEST_TIMEOUT);
});
