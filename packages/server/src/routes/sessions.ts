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

    // List sessions — scoped to own device, optionally filtered by windowId.
    // history=1 is used by the mobile history page so transient bridge
    // disconnect cleanup does not make recently finished CC sessions disappear.
    fastify.get('/sessions', { preHandler: [tokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { windowId, history } = req.query as { windowId?: string; history?: string };
      const includeHistory = history === '1' || history === 'true';
      // Return all active sessions that have a claudeSessionId — not just
      // transcript_attach. Hook-created sessions (source='hook') also need to
      // appear so the sidebar can overlay their relay-synced titles on the
      // local transcript list.
      let query = includeHistory
        ? sql`SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.pending = true)::int AS pending_count FROM sessions s WHERE s.device_id = ${deviceAuth.deviceId} AND coalesce(s.metadata->>'claudeSessionId', '') <> '' AND (s.status IN ('active', 'paused') OR (s.status = 'finished' AND s.finished_at > now() - interval '7 days'))`
        : sql`SELECT s.*, (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.pending = true)::int AS pending_count FROM sessions s WHERE s.device_id = ${deviceAuth.deviceId} AND s.status = 'active' AND coalesce(s.metadata->>'claudeSessionId', '') <> ''`;
      if (windowId) {
        query = sql`${query} AND s.metadata->>'windowId' = ${windowId}`;
      }
      query = sql`${query} ORDER BY CASE WHEN s.status = 'active' THEN 0 ELSE 1 END, s.last_active_at DESC`;
      return await query;
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
