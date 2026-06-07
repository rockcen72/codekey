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
      // Mobile apps use this endpoint without windowId; sidebar uses it with windowId.
      const sourceFilter = windowId
        ? sql``
        : sql`AND coalesce(s.metadata->>'source', '') IN ('transcript_attach', 'resume', 'opencode', 'opencode_attach', 'managed_codex_relay')`;
      const statusFilter = includeHistory
        ? sql`AND (s.status IN ('active', 'paused') OR (s.status = 'finished' AND s.finished_at > now() - interval '7 days'))`
        : sql`AND s.status = 'active'`;
      let query = sql`
        SELECT id, device_id, agent_type, status, cwd, project_name, metadata,
               started_at, finished_at, last_active_at, pending_count
        FROM (
          SELECT s.*,
                 (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.pending = true)::int AS pending_count,
                 row_number() OVER (
                   PARTITION BY s.agent_type, s.metadata->>'claudeSessionId'
                   ORDER BY CASE WHEN s.status = 'active' THEN 0 ELSE 1 END, s.last_active_at DESC
                 ) AS rn
          FROM sessions s
          WHERE s.device_id = ${deviceAuth.deviceId}
            AND coalesce(s.metadata->>'claudeSessionId', '') <> ''
            AND coalesce(s.metadata->>'hideFromMobileHistory', '') <> 'true'
            ${sourceFilter}
            ${statusFilter}
      `;
      if (windowId) {
        query = sql`${query} AND s.metadata->>'windowId' = ${windowId}`;
      }
      query = sql`${query}) ranked WHERE rn = 1 ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, last_active_at DESC`;
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

    // Hide session from mobile history — any valid token (client or device)
    fastify.patch('/sessions/:id/hide', { preHandler: [tokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { id } = req.params as { id: string };
      const [session] = await sql`
        SELECT id FROM sessions WHERE id = ${id} AND device_id = ${deviceAuth.deviceId}
      `;
      if (!session) return reply.code(404).send({ error: 'not found' });
      await sql`
        UPDATE sessions
        SET metadata = metadata || ${sql.json({ hideFromMobileHistory: 'true' })}
        WHERE id = ${id}
      `;
      return { success: true };
    });
  };
}
