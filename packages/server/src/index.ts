import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyCors from '@fastify/cors';
import { deviceRoutes } from './routes/devices.js';
import { sessionRoutes } from './routes/sessions.js';
import { auditRoutes } from './routes/audit.js';
import { wsHandler } from './ws/handler.js';
import { initDb } from './db/init.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://devtap:devtap@localhost:5432/devtap';

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
  return { app, sql };
}

async function main() {
  const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://devtap:devtap@localhost:5432/devtap';
  const { app } = await buildApp(DATABASE_URL);
  await app.listen({ port: PORT, host: HOST });
  console.log(`Relay server listening on ${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
