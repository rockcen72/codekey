import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Devices API', () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    const built = await buildApp(DATABASE_URL!);
    app = built.app;
    sql = built.sql;
  });

  beforeEach(async () => {
    await sql`DELETE FROM pairing_codes WHERE ip_address IN ('127.0.0.1', '::1')`;
  });

  afterAll(async () => {
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

  it('bootstraps a new device on pair without deviceId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: {
        deviceSecretHash: 'a'.repeat(64),
        deviceName: 'test-pc',
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.code).toHaveLength(8);
    expect(body.deviceId).toBeDefined();
    expect(body.expiresIn).toBe(300);
    cleanupIds.push(body.deviceId);
  });

  it('rejects pair with wrong device_secret for existing deviceId', async () => {
    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: 'v'.repeat(64), deviceName: 'pc2' },
    });
    const { deviceId } = JSON.parse(boot.payload);
    cleanupIds.push(deviceId);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceId, deviceSecretHash: 'w'.repeat(64) },
    });
    expect(res.statusCode).toBe(403);
  });

  it('confirms pairing code one-time', async () => {
    const pair = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: 'b'.repeat(64), deviceName: 'pc3' },
    });
    const { code, deviceId } = JSON.parse(pair.payload);
    cleanupIds.push(deviceId);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/confirm',
      payload: { code },
    });
    expect(confirm.statusCode).toBe(200);
    const body = JSON.parse(confirm.payload);
    expect(body.clientToken).toBeDefined();
    expect(body.deviceId).toBeDefined();

    // Second confirm should fail (one-time)
    const retry = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/confirm',
      payload: { code },
    });
    expect(retry.statusCode).toBe(404);
  });

  it('confirms pairing code with telegram platform label', async () => {
    const pair = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: 't'.repeat(64), deviceName: 'telegram-pc' },
    });
    const { code, deviceId } = JSON.parse(pair.payload);
    cleanupIds.push(deviceId);

    const confirm = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/confirm',
      payload: { code, platform: 'telegram' },
    });
    expect(confirm.statusCode).toBe(200);

    const [token] = await sql<{ label: string }[]>`
      SELECT label FROM device_tokens
      WHERE device_id = ${deviceId} AND token_type = 'client'
    `;
    expect(token?.label).toBe('telegram-miniapp');
  });
});
