import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Sessions API', () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    const built = await buildApp(DATABASE_URL!);
    app = built.app;
    sql = built.sql;
  });

  afterAll(async () => {
    for (const did of cleanupIds) {
      try { await sql`DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE device_id = ${did})`; } catch { /* ignore */ }
      try { await sql`DELETE FROM sessions WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM device_tokens WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM devices WHERE id = ${did}`; } catch { /* ignore */ }
    }
    await app.close();
    await sql.end();
  });

  it('keeps recent finished Claude Code sessions visible only in mobile history mode', async () => {
    const [{ id: deviceId }] = await sql`
      INSERT INTO devices (device_name)
      VALUES ('history-test-device')
      RETURNING id
    `;
    cleanupIds.push(deviceId);

    const token = randomUUID();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await sql`
      INSERT INTO device_tokens (device_id, token_type, token_hash)
      VALUES (${deviceId}, 'client', ${tokenHash})
    `;

    const [active] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, metadata, last_active_at)
      VALUES (${deviceId}, 'claude-code', 'active', ${sql.json({ claudeSessionId: 'active-cc' })}, now())
      RETURNING id
    `;
    const [recentFinished] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, metadata, finished_at, last_active_at)
      VALUES (${deviceId}, 'claude-code', 'finished', ${sql.json({ claudeSessionId: 'recent-finished-cc' })}, now(), now() - interval '1 minute')
      RETURNING id
    `;
    const [oldFinished] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, metadata, finished_at, last_active_at)
      VALUES (${deviceId}, 'claude-code', 'finished', ${sql.json({ claudeSessionId: 'old-finished-cc' })}, now() - interval '8 days', now() - interval '8 days')
      RETURNING id
    `;

    const auth = { authorization: `Bearer ${token}` };
    const activeRes = await app.inject({ method: 'GET', url: '/api/v1/sessions', headers: auth });
    expect(activeRes.statusCode).toBe(200);
    expect(JSON.parse(activeRes.payload).map((s: any) => s.id)).toEqual([active.id]);

    const historyRes = await app.inject({ method: 'GET', url: '/api/v1/sessions?history=1', headers: auth });
    expect(historyRes.statusCode).toBe(200);
    const historyIds = JSON.parse(historyRes.payload).map((s: any) => s.id);
    expect(historyIds).toContain(active.id);
    expect(historyIds).toContain(recentFinished.id);
    expect(historyIds).not.toContain(oldFinished.id);
  });

  it('dedupes mobile history by agent and claudeSessionId with active row preferred', async () => {
    const [{ id: deviceId }] = await sql`
      INSERT INTO devices (device_name)
      VALUES ('history-dedupe-test-device')
      RETURNING id
    `;
    cleanupIds.push(deviceId);

    const token = randomUUID();
    const tokenHash = createHash('sha256').update(token).digest('hex');
    await sql`
      INSERT INTO device_tokens (device_id, token_type, token_hash)
      VALUES (${deviceId}, 'client', ${tokenHash})
    `;

    const [finishedDuplicate] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, metadata, finished_at, last_active_at)
      VALUES (${deviceId}, 'claude-code-hook', 'finished', ${sql.json({ claudeSessionId: 'same-cc' })}, now(), now() - interval '1 minute')
      RETURNING id
    `;
    const [activeDuplicate] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, metadata, last_active_at)
      VALUES (${deviceId}, 'claude-code-hook', 'active', ${sql.json({ claudeSessionId: 'same-cc' })}, now())
      RETURNING id
    `;
    const [finishedOnly] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, metadata, finished_at, last_active_at)
      VALUES (${deviceId}, 'claude-code-hook', 'finished', ${sql.json({ claudeSessionId: 'finished-only' })}, now(), now() - interval '2 minutes')
      RETURNING id
    `;
    const [manualDetached] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, metadata, finished_at, last_active_at)
      VALUES (${deviceId}, 'claude-code-hook', 'finished', ${sql.json({ claudeSessionId: 'manual-detached', hideFromMobileHistory: 'true' })}, now(), now() - interval '3 minutes')
      RETURNING id
    `;

    const historyRes = await app.inject({
      method: 'GET',
      url: '/api/v1/sessions?history=1',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(historyRes.statusCode).toBe(200);
    const historyIds = JSON.parse(historyRes.payload).map((s: any) => s.id);

    expect(historyIds).toContain(activeDuplicate.id);
    expect(historyIds).not.toContain(finishedDuplicate.id);
    expect(historyIds).toContain(finishedOnly.id);
    expect(historyIds).not.toContain(manualDetached.id);
  });
});
