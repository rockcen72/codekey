import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../index.js';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Devices API', () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const built = await buildApp(DATABASE_URL!);
    app = built.app;
    sql = built.sql;
  });

  afterAll(async () => {
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
  });

  it('rejects pair with wrong device_secret for existing deviceId', async () => {
    const boot = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: 'validhash', deviceName: 'pc2' },
    });
    const { deviceId } = JSON.parse(boot.payload);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceId, deviceSecretHash: 'wronghash' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('confirms pairing code one-time', async () => {
    const pair = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair',
      payload: { deviceSecretHash: 'b'.repeat(64), deviceName: 'pc3' },
    });
    const { code } = JSON.parse(pair.payload);

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
});
