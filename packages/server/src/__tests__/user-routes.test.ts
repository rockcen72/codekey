import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('User-scoped routes', () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  const cleanupUserIds: number[] = [];
  const cleanupDeviceIds: string[] = [];

  // Helper: create a user via telegram login and return { userId, token }
  // NOTE: auth.ts validates telegramId must match /^\d{1,32}$/, so we use
  // numeric strings (Date.now() + random digits) to stay valid.
  async function createTelegramUser(telegramId?: string) {
    const tid = telegramId || `${Date.now()}${Math.floor(Math.random() * 10000)}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/telegram',
      headers: { 'x-codekey-telegram-secret': 'test-telegram-login-secret' },
      payload: { telegramId: tid, username: 'testuser' },
    });
    const body = JSON.parse(res.payload);
    return { userId: body.userId, token: body.token, telegramId: tid };
  }

  // Helper: create a device + client token via pair/confirm
  async function createDeviceAndClient(label?: string) {
    const name = label || `test-device-${Math.random().toString(36).slice(2)}`;
    const secret = randomBytes(32).toString('hex');
    const pair = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: secret, deviceName: name },
    });
    const { code, deviceId } = JSON.parse(pair.payload);
    cleanupDeviceIds.push(deviceId);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/confirm',
      payload: { code, platform: 'telegram' },
    });
    const { clientToken } = JSON.parse(confirm.payload);
    return { deviceId, clientToken, code };
  }

  // Helper: create a session for a device
  async function createSession(deviceToken: string, agentType = 'claude-code') {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/sessions',
      headers: { authorization: `Bearer ${deviceToken}` },
      payload: { agentType },
    });
    return JSON.parse(res.payload);
  }

  // Helper: create a device token for a device
  async function createDeviceToken(deviceId: string) {
    const token = randomUUID();
    const hash = createHash('sha256').update(token).digest('hex');
    await sql`
      INSERT INTO device_tokens (device_id, token_type, token_hash, label, expires_at)
      VALUES (${deviceId}, 'device', ${hash}, 'test-device-token', now() + interval '365 days')
    `;
    return token;
  }

  // Helper: create an event for a session
  async function createEvent(sessionId: string, pending = true) {
    const [event] = await sql`
      INSERT INTO events (session_id, type, data, pending, risk_level)
      VALUES (${sessionId}, 'permission_request', ${sql.json({ command: 'rm -rf /', clientEventId: randomUUID() })}, ${pending}, 'medium')
      RETURNING id, session_id, type, pending
    `;
    return event;
  }

  function randomUUID() {
    return `${randomBytes(4).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(2).toString('hex')}-${randomBytes(6).toString('hex')}`;
  }

  beforeAll(async () => {
    process.env.WECHAT_APPID = 'mock';
    process.env.USER_JWT_SECRET = process.env.USER_JWT_SECRET || 'test-secret-' + 'x'.repeat(40);
    process.env.TELEGRAM_LOGIN_SECRET = 'test-telegram-login-secret';

    const built = await buildApp(DATABASE_URL!);
    app = built.app;
    sql = built.sql;
  });

  afterAll(async () => {
    // Cleanup: delete in reverse dependency order
    for (const did of cleanupDeviceIds) {
      try { await sql`DELETE FROM device_tokens WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM device_bindings WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM devices WHERE id = ${did}`; } catch { /* ignore */ }
    }
    for (const uid of cleanupUserIds) {
      try { await sql`DELETE FROM auth_identities WHERE user_id = ${uid}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM device_bindings WHERE user_id = ${uid}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM users WHERE id = ${uid}`; } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  // ── GET /api/v1/user/sessions ──────────────────────────────

  it('user/sessions: returns sessions across all bound devices', async () => {
    const { userId, token } = await createTelegramUser();
    cleanupUserIds.push(userId);

    // Create a device and bind it to the user
    const { deviceId, clientToken } = await createDeviceAndClient('session-device-1');
    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });
    expect(claim.statusCode).toBe(200);

    // Create a device token and a session
    const deviceToken = await createDeviceToken(deviceId);
    const session = await createSession(deviceToken);
    // Update session metadata to have a claudeSessionId so it appears in listings
    await sql`
      UPDATE sessions SET metadata = ${sql.json({ claudeSessionId: 'test-session-1', title: 'Test Session' })} WHERE id = ${session.sessionId}
    `;

    // Query user sessions
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/user/sessions?history=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const sessions = JSON.parse(res.payload);
    expect(Array.isArray(sessions)).toBe(true);
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions.some((s: any) => s.id === session.sessionId)).toBe(true);
  });

  it('user/sessions: returns empty array for user with no bound devices', async () => {
    const { token } = await createTelegramUser();
    // No devices bound — should return empty array

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/user/sessions',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const sessions = JSON.parse(res.payload);
    expect(sessions).toEqual([]);
  });

  it('user/sessions: other user cannot see sessions from unowned device', async () => {
    const { userId: user1Id, token: token1 } = await createTelegramUser();
    const { token: token2 } = await createTelegramUser();
    cleanupUserIds.push(user1Id);

    // Create device for user1, bind it
    const { deviceId, clientToken } = await createDeviceAndClient('unbound-device');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token1}` },
      payload: { clientToken },
    });

    // Create session on that device
    const deviceToken = await createDeviceToken(deviceId);
    const session = await createSession(deviceToken);
    await sql`
      UPDATE sessions SET metadata = ${sql.json({ claudeSessionId: 'secret-session' })} WHERE id = ${session.sessionId}
    `;

    // user1 can see the session
    const res1 = await app.inject({
      method: 'GET',
      url: '/api/v1/user/sessions?history=1',
      headers: { authorization: `Bearer ${token1}` },
    });
    expect(res1.statusCode).toBe(200);
    const sessions1 = JSON.parse(res1.payload);
    expect(sessions1.some((s: any) => s.id === session.sessionId)).toBe(true);

    // user2 cannot see user1's session
    const res2 = await app.inject({
      method: 'GET',
      url: '/api/v1/user/sessions?history=1',
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(res2.statusCode).toBe(200);
    const sessions2 = JSON.parse(res2.payload);
    expect(sessions2.some((s: any) => s.id === session.sessionId)).toBe(false);
  });

  it('user/sessions: hides sessions from unbound (soft-deleted) devices', async () => {
    const { userId, token } = await createTelegramUser();
    cleanupUserIds.push(userId);

    // Create device and bind it
    const { deviceId, clientToken } = await createDeviceAndClient('will-unbind');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });

    // Create session on the device
    const deviceToken = await createDeviceToken(deviceId);
    const session = await createSession(deviceToken);
    await sql`
      UPDATE sessions SET metadata = ${sql.json({ claudeSessionId: 'unbound-session' })} WHERE id = ${session.sessionId}
    `;

    // Before unbind: user can see the session
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/user/sessions?history=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);
    const beforeData = JSON.parse(before.payload);
    expect(beforeData.some((s: any) => s.id === session.sessionId)).toBe(true);

    // Soft-delete (unbind) the device
    await sql`
      UPDATE device_bindings SET unbound_at = now() WHERE device_id = ${deviceId}
    `;

    // After unbind: user can no longer see the session
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/user/sessions?history=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(200);
    const afterData = JSON.parse(after.payload);
    expect(afterData.some((s: any) => s.id === session.sessionId)).toBe(false);
  });

  it('user/sessions: 401 without bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/user/sessions',
    });
    expect(res.statusCode).toBe(401);
  });

  // ── GET /api/v1/user/sessions/:id ──────────────────────────

  it('user/sessions/:id: returns session detail for bound device', async () => {
    const { userId, token } = await createTelegramUser();
    cleanupUserIds.push(userId);

    const { deviceId, clientToken } = await createDeviceAndClient('detail-device');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });

    const deviceToken = await createDeviceToken(deviceId);
    const session = await createSession(deviceToken);
    await sql`
      UPDATE sessions SET metadata = ${sql.json({ claudeSessionId: 'detail-session' })} WHERE id = ${session.sessionId}
    `;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/user/sessions/${session.sessionId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.id).toBe(session.sessionId);
  });

  it('user/sessions/:id: returns 404 for session on another user\'s device', async () => {
    const { userId, token: token1 } = await createTelegramUser();
    const { token: token2 } = await createTelegramUser();
    cleanupUserIds.push(userId);

    const { deviceId, clientToken } = await createDeviceAndClient('other-device');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token1}` },
      payload: { clientToken },
    });

    const deviceToken = await createDeviceToken(deviceId);
    const session = await createSession(deviceToken);
    await sql`
      UPDATE sessions SET metadata = ${sql.json({ claudeSessionId: 'private-session' })} WHERE id = ${session.sessionId}
    `;

    // user2 cannot see user1's session
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/user/sessions/${session.sessionId}`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── GET /api/v1/user/sessions/:id/events ────────────────────

  it('user/sessions/:id/events: returns events for bound device', async () => {
    const { userId, token } = await createTelegramUser();
    cleanupUserIds.push(userId);

    const { deviceId, clientToken } = await createDeviceAndClient('events-device');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });

    const deviceToken = await createDeviceToken(deviceId);
    const session = await createSession(deviceToken);
    await sql`
      UPDATE sessions SET metadata = ${sql.json({ claudeSessionId: 'events-session' })} WHERE id = ${session.sessionId}
    `;

    // Create events for this session
    await createEvent(session.sessionId, true);
    await createEvent(session.sessionId, false);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/user/sessions/${session.sessionId}/events`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const events = JSON.parse(res.payload);
    expect(Array.isArray(events)).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(2);
  });

  it('user/sessions/:id/events: returns 404 for session on another user\'s device', async () => {
    const { userId, token: token1 } = await createTelegramUser();
    const { token: token2 } = await createTelegramUser();
    cleanupUserIds.push(userId);

    const { deviceId, clientToken } = await createDeviceAndClient('events-other-device');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token1}` },
      payload: { clientToken },
    });

    const deviceToken = await createDeviceToken(deviceId);
    const session = await createSession(deviceToken);
    await sql`
      UPDATE sessions SET metadata = ${sql.json({ claudeSessionId: 'private-events' })} WHERE id = ${session.sessionId}
    `;
    await createEvent(session.sessionId, true);

    // user2 cannot see user1's events
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/user/sessions/${session.sessionId}/events`,
      headers: { authorization: `Bearer ${token2}` },
    });
    expect(res.statusCode).toBe(404);
  });

  // ── GET /api/v1/user/devices ────────────────────────────────

  it('user/devices: returns bound devices', async () => {
    const { userId, token } = await createTelegramUser();
    cleanupUserIds.push(userId);

    const { deviceId, clientToken } = await createDeviceAndClient('my-device');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/user/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const devices = JSON.parse(res.payload);
    expect(Array.isArray(devices)).toBe(true);
    expect(devices.some((d: any) => d.id === deviceId)).toBe(true);
  });

  it('user/devices: returns empty array for user with no bindings', async () => {
    const { token } = await createTelegramUser();

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/user/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const devices = JSON.parse(res.payload);
    expect(devices).toEqual([]);
  });

  it('user/devices: excludes unbound (soft-deleted) devices', async () => {
    const { userId, token } = await createTelegramUser();
    cleanupUserIds.push(userId);

    const { deviceId, clientToken } = await createDeviceAndClient('will-unbind-device');
    await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });

    // Before unbind: device appears in list
    const before = await app.inject({
      method: 'GET',
      url: '/api/v1/user/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(before.statusCode).toBe(200);
    const beforeDevices = JSON.parse(before.payload);
    expect(beforeDevices.some((d: any) => d.id === deviceId)).toBe(true);

    // Soft-delete (unbind) the device
    await sql`
      UPDATE device_bindings SET unbound_at = now() WHERE device_id = ${deviceId}
    `;

    // After unbind: device no longer appears
    const after = await app.inject({
      method: 'GET',
      url: '/api/v1/user/devices',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(after.statusCode).toBe(200);
    const afterDevices = JSON.parse(after.payload);
    expect(afterDevices.some((d: any) => d.id === deviceId)).toBe(false);
  });

  it('user/devices: 401 without bearer token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/user/devices',
    });
    expect(res.statusCode).toBe(401);
  });
});