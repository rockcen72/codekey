import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { deviceRoutes } from './routes/devices.js';
import { sessionRoutes } from './routes/sessions.js';
import { auditRoutes } from './routes/audit.js';
import { wsHandler } from './ws/handler.js';
import { initDb } from './db/init.js';
import type postgres from 'postgres';

const CLEANUP_INTERVAL_MS = 60_000; // check every 60s
const PENDING_TTL_MS = 5 * 60_000;  // expire events pending >5min
const SESSION_IDLE_TTL_MS = 30 * 60_000; // close sessions idle >30min

async function runCleanup(sql: postgres.Sql): Promise<void> {
  // 1. Expire stuck pending events (global TTL)
  const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
  await sql`
    UPDATE events SET pending = false, decision = 'expired'
    WHERE pending = true AND created_at < ${cutoff}::timestamptz
  `;

  // 2. Find active sessions with no recent activity and close them.
  //    A session is stale if it hasn't been updated in SESSION_IDLE_TTL_MS.
  const idleSince = new Date(Date.now() - SESSION_IDLE_TTL_MS).toISOString();
  const staleSessions = await sql`
    SELECT id FROM sessions
    WHERE status = 'active' AND last_active_at < ${idleSince}::timestamptz
  `;
  for (const s of staleSessions) {
    await sql`
      UPDATE events SET pending = false, decision = 'expired'
      WHERE session_id = ${s.id} AND pending = true
    `;
    await sql`
      UPDATE sessions SET status = 'finished', finished_at = now()
      WHERE id = ${s.id} AND status = 'active'
    `;
  }
}

function startAutoCleanup(sql: postgres.Sql): () => void {
  const timer = setInterval(async () => {
    try {
      await runCleanup(sql);
    } catch (err) {
      console.error('[cleanup] error:', err);
    }
  }, CLEANUP_INTERVAL_MS);
  return () => clearInterval(timer);
}

export async function buildApp(databaseUrl: string) {
  const sql = await initDb(databaseUrl);
  const app = Fastify({ logger: false });

  await app.register(fastifyCors, { origin: true });
  await app.register(fastifyWebsocket);

  // REST routes
  await app.register(deviceRoutes(sql), { prefix: '/api/v1' });
  await app.register(sessionRoutes(sql), { prefix: '/api/v1' });
  await app.register(auditRoutes(sql), { prefix: '/api/v1' });

  // WebSocket
  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, wsHandler(sql));
  });

  // Health check
  app.get('/health', async () => ({ status: 'ok', ts: new Date().toISOString() }));

  // Auto-expire pending events older than PENDING_TTL_MS
  const stopCleanup = startAutoCleanup(sql);

  return { app, sql, stopCleanup };
}
