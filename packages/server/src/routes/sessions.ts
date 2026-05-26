import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { tokenAuth, deviceTokenAuth } from '../auth/middleware.js';

export function sessionRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    // Register new session (PC daemon)
    fastify.post('/sessions', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { agentType } = req.body as { agentType?: string };
      if (!agentType) {
        return reply.code(400).send({ error: 'agentType required' });
      }
      const [session] = await sql`
        INSERT INTO sessions (device_id, agent_type, status, metadata)
        VALUES (${deviceAuth.deviceId}, ${agentType}, 'active', '{}')
        RETURNING id, created_at
      `;
      return { sessionId: session.id, createdAt: session.created_at };
    });

    // List sessions (mini program) — scoped to own device
    fastify.get('/sessions', { preHandler: [tokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const sessions = await sql`
        SELECT * FROM sessions WHERE device_id = ${deviceAuth.deviceId} ORDER BY last_active_at DESC
      `;
      return sessions;
    });

    // Get session detail — scoped to own device
    fastify.get('/sessions/:id', { preHandler: [tokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { id } = req.params as { id: string };
      const [session] = await sql`
        SELECT * FROM sessions WHERE id = ${id} AND device_id = ${deviceAuth.deviceId}
      `;
      if (!session) return reply.code(404).send({ error: 'not found' });
      return session;
    });

    // Get session events — scoped to own device
    fastify.get('/sessions/:id/events', { preHandler: [tokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { id } = req.params as { id: string };
      // Verify session ownership first
      const [session] = await sql`
        SELECT id FROM sessions WHERE id = ${id} AND device_id = ${deviceAuth.deviceId}
      `;
      if (!session) return reply.code(404).send({ error: 'not found' });
      const events = await sql`
        SELECT * FROM events WHERE session_id = ${id} ORDER BY created_at DESC
      `;
      return events;
    });

    // Pause session — device token only, scoped to own device
    fastify.post('/sessions/:id/pause', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { id } = req.params as { id: string };
      const [session] = await sql`
        SELECT id FROM sessions WHERE id = ${id} AND device_id = ${deviceAuth.deviceId}
      `;
      if (!session) return reply.code(404).send({ error: 'not found' });
      await sql`UPDATE sessions SET status = 'paused' WHERE id = ${id}`;
      return { success: true };
    });

    // Delete session — device token only
    fastify.delete('/sessions/:id', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { id } = req.params as { id: string };
      const [session] = await sql`
        SELECT id FROM sessions WHERE id = ${id} AND device_id = ${deviceAuth.deviceId}
      `;
      if (!session) return reply.code(404).send({ error: 'not found' });
      await sql`DELETE FROM sessions WHERE id = ${id}`;
      return { success: true };
    });
  };
}
