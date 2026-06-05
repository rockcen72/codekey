import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import { signUserJwt } from '../auth/jwt.js';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Auth API (Phase 1)', () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  const cleanupUserIds: number[] = [];
  const cleanupDeviceIds: string[] = [];

  beforeAll(async () => {
    // Force mock mode for the WeChat login endpoint so the test does
    // not need a real WECHAT_APPID/SECRET. The mock branch trusts the
    // body's `openid` field (or derives one from the code).
    process.env.WECHAT_APPID = 'mock';
    process.env.USER_JWT_SECRET = process.env.USER_JWT_SECRET || 'test-secret-' + 'x'.repeat(40);

    const built = await buildApp(DATABASE_URL!);
    app = built.app;
    sql = built.sql;
  });

  beforeEach(async () => {
    // Don't wipe between tests; just rely on the per-test cleanup hooks
    // so the auth_identities PK conflicts are avoided.
  });

  afterAll(async () => {
    for (const uid of cleanupUserIds) {
      try { await sql`DELETE FROM auth_identities WHERE user_id = ${uid}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM device_bindings WHERE user_id = ${uid}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM users WHERE id = ${uid}`; } catch { /* ignore */ }
    }
    for (const did of cleanupDeviceIds) {
      try { await sql`DELETE FROM device_tokens WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM device_bindings WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM devices WHERE id = ${did}`; } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  // ── POST /api/v1/auth/wx-login ────────────────────────────

  it('wx-login: creates user + auth_identity on first login', async () => {
    const openid = `test-openid-${Date.now()}-${Math.random()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'fake-wx-code', provider: 'wechat', openid },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.isNew).toBe(true);
    expect(typeof body.userId).toBe('number');
    expect(typeof body.token).toBe('string');
    cleanupUserIds.push(body.userId);
  });

  it('wx-login: returns existing user on repeat login (same openid)', async () => {
    const openid = `test-openid-${Date.now()}-${Math.random()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'c1', provider: 'wechat', openid },
    });
    const firstBody = JSON.parse(first.payload);
    cleanupUserIds.push(firstBody.userId);

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'c2', provider: 'wechat', openid },
    });
    const secondBody = JSON.parse(second.payload);
    expect(second.statusCode).toBe(200);
    expect(secondBody.isNew).toBe(false);
    expect(secondBody.userId).toBe(firstBody.userId);
  });

  it('wx-login: rejects missing code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { provider: 'wechat' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('wx-login: feishu provider is accepted and creates separate identity row', async () => {
    const openid = `feishu-${Date.now()}-${Math.random()}`;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'fc', provider: 'feishu', openid },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.isNew).toBe(true);
    cleanupUserIds.push(body.userId);

    // Verify the row actually got stored under 'feishu' provider
    const [row] = await sql`
      SELECT provider FROM auth_identities WHERE user_id = ${body.userId}
    `;
    expect(row?.provider).toBe('feishu');
  });

  // ── POST /api/v1/auth/claim-device ────────────────────────

  it('claim-device: 401 without bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      payload: { clientToken: 'whatever' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('claim-device: binds current device to user via clientToken', async () => {
    // Bootstrap a device + client token via the existing /devices flow
    const pair = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: 'c'.repeat(64), deviceName: 'claim-pc' },
    });
    const { code, deviceId } = JSON.parse(pair.payload);
    cleanupDeviceIds.push(deviceId);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/confirm',
      payload: { code },
    });
    const { clientToken } = JSON.parse(confirm.payload);

    // Create a user
    const openid = `claim-user-${Date.now()}-${Math.random()}`;
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'lc', provider: 'wechat', openid },
    });
    const { token, userId } = JSON.parse(login.payload);
    cleanupUserIds.push(userId);

    // Claim the device
    const claim = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });
    expect(claim.statusCode).toBe(200);
    const claimBody = JSON.parse(claim.payload);
    expect(claimBody.success).toBe(true);
    expect(claimBody.deviceId).toBe(deviceId);

    // Verify binding exists
    const [binding] = await sql`
      SELECT user_id FROM device_bindings WHERE device_id = ${deviceId}
    `;
    expect(binding?.user_id).toBe(userId);
  });

  it('claim-device: 409 when device already bound to same user', async () => {
    // Setup: device + client token
    const pair = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: 'd'.repeat(64), deviceName: 'claim-pc-2' },
    });
    const { code, deviceId } = JSON.parse(pair.payload);
    cleanupDeviceIds.push(deviceId);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/confirm',
      payload: { code },
    });
    const { clientToken } = JSON.parse(confirm.payload);

    // User + claim once
    const openid = `dup-user-${Date.now()}-${Math.random()}`;
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'ld', provider: 'wechat', openid },
    });
    const { token, userId } = JSON.parse(login.payload);
    cleanupUserIds.push(userId);

    const claim1 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });
    expect(claim1.statusCode).toBe(200);

    // Re-claim should be 409
    const claim2 = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken },
    });
    expect(claim2.statusCode).toBe(409);
  });

  it('claim-device: 404 on invalid clientToken', async () => {
    const openid = `bad-token-user-${Date.now()}-${Math.random()}`;
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'lt', provider: 'wechat', openid },
    });
    const { token, userId } = JSON.parse(login.payload);
    cleanupUserIds.push(userId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: { clientToken: 'definitely-not-a-real-token' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('claim-device: 400 on missing clientToken', async () => {
    const openid = `missing-token-user-${Date.now()}-${Math.random()}`;
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/wx-login',
      payload: { code: 'lm', provider: 'wechat', openid },
    });
    const { token, userId } = JSON.parse(login.payload);
    cleanupUserIds.push(userId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  // ── user-middleware ───────────────────────────────────────

  it('user-middleware: 401 on missing authorization header', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      payload: { clientToken: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('user-middleware: 401 on garbage token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: 'Bearer not.a.jwt' },
      payload: { clientToken: 'x' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('user-middleware: a freshly-signed valid token lets the request through (until claim step rejects for other reasons)', async () => {
    const token = signUserJwt(99999);
    // No clientToken in body → 400 (not 401), proving the middleware
    // accepted the JWT and the route ran.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/claim-device',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
