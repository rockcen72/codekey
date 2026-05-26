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

function startAutoCleanup(sql: postgres.Sql): () => void {
  const timer = setInterval(async () => {
    try {
      const cutoff = new Date(Date.now() - PENDING_TTL_MS).toISOString();
      await sql`
        UPDATE events SET pending = false, decision = 'expired'
        WHERE pending = true AND created_at < ${cutoff}::timestamptz
      `;
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
