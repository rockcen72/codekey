import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../app.js';
import { runRetentionCleanup, getRetentionDays } from '../services/cleanup.js';
import type postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Cleanup — runRetentionCleanup', () => {
  let sql: postgres.Sql;
  const cleanupIds: string[] = [];

  beforeAll(async () => {
    const built = await buildApp(DATABASE_URL!);
    sql = built.sql;
  });

  afterAll(async () => {
    for (const did of cleanupIds) {
      try { await sql`DELETE FROM approvals WHERE event_id IN (SELECT id FROM events WHERE session_id IN (SELECT id FROM sessions WHERE device_id = ${did}))`; } catch { /* ignore */ }
      try { await sql`DELETE FROM events WHERE session_id IN (SELECT id FROM sessions WHERE device_id = ${did})`; } catch { /* ignore */ }
      try { await sql`DELETE FROM sessions WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM device_tokens WHERE device_id = ${did}`; } catch { /* ignore */ }
      try { await sql`DELETE FROM devices WHERE id = ${did}`; } catch { /* ignore */ }
    }
    await sql.end();
  });

  it('deletes finished sessions older than retention days', async () => {
    const [{ id: deviceId }] = await sql`
      INSERT INTO devices (device_name) VALUES ('retention-test-old')
      RETURNING id
    `;
    cleanupIds.push(deviceId);

    const [oldFinished] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, finished_at, last_active_at)
      VALUES (${deviceId}, 'test', 'finished', now() - interval '8 days', now() - interval '8 days')
      RETURNING id
    `;
    const [evt] = await sql`
      INSERT INTO events (session_id, type, data)
      VALUES (${oldFinished.id}, 'test', ${sql.json({ msg: 'old event' })})
      RETURNING id
    `;
    await sql`
      INSERT INTO approvals (event_id, session_id, decision, command, risk_level, message)
      VALUES (${evt.id}, ${oldFinished.id}, 'approved', 'test-cmd', 'low', 'test approval')
    `;

    await runRetentionCleanup(sql);

    const remaining = await sql`SELECT id FROM sessions WHERE id = ${oldFinished.id}`;
    expect(remaining.length).toBe(0);
    const approvals = await sql`SELECT id FROM approvals WHERE session_id = ${oldFinished.id}`;
    expect(approvals.length).toBe(0);
    const events = await sql`SELECT id FROM events WHERE session_id = ${oldFinished.id}`;
    expect(events.length).toBe(0);
  });

  it('keeps finished sessions within retention window', async () => {
    const [{ id: deviceId }] = await sql`
      INSERT INTO devices (device_name) VALUES ('retention-test-recent')
      RETURNING id
    `;
    cleanupIds.push(deviceId);

    const [recentFinished] = await sql`
      INSERT INTO sessions (device_id, agent_type, status, finished_at, last_active_at)
      VALUES (${deviceId}, 'test', 'finished', now() - interval '1 day', now() - interval '1 day')
      RETURNING id
    `;

    await runRetentionCleanup(sql);

    const remaining = await sql`SELECT id FROM sessions WHERE id = ${recentFinished.id}`;
    expect(remaining.length).toBe(1);
  });

  it('keeps active sessions regardless of age', async () => {
    const [{ id: deviceId }] = await sql`
      INSERT INTO devices (device_name) VALUES ('retention-test-active')
      RETURNING id
    `;
    cleanupIds.push(deviceId);

    const [oldActive] = await sql`
      INSERT INTO sessions (device_id, agent_type, status)
      VALUES (${deviceId}, 'test', 'active')
      RETURNING id
    `;

    await runRetentionCleanup(sql);

    const remaining = await sql`SELECT id FROM sessions WHERE id = ${oldActive.id}`;
    expect(remaining.length).toBe(1);
  });
});

describeDb('Cleanup — getRetentionDays', () => {
  afterAll(() => {
    delete process.env.EVENT_RETENTION_DAYS;
  });

  it('returns 7 when unset', () => {
    delete process.env.EVENT_RETENTION_DAYS;
    expect(getRetentionDays()).toBe(7);
  });

  it('returns 0 when set to "0"', () => {
    process.env.EVENT_RETENTION_DAYS = '0';
    expect(getRetentionDays()).toBe(0);
  });

  it('returns 7 when empty string', () => {
    process.env.EVENT_RETENTION_DAYS = '';
    expect(getRetentionDays()).toBe(7);
  });

  it('returns 0 for non-positive values', () => {
    process.env.EVENT_RETENTION_DAYS = '-1';
    expect(getRetentionDays()).toBe(0);
  });

  it('returns 0 for non-integer values', () => {
    process.env.EVENT_RETENTION_DAYS = 'abc';
    expect(getRetentionDays()).toBe(0);
  });
});
