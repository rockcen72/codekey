import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { userTokenAuth } from '../auth/user-middleware.js';
import { clientClients, pcClients } from '../ws/connection-registry.js';
import { validateAndApplyApproval } from '../services/approval.js';

/**
 * User-scoped routes — authenticated via user_token (JWT).
 *
 * All endpoints query data through device_bindings to ensure
 * the user can only access sessions/events belonging to
 * devices they have bound (WHERE unbound_at IS NULL).
 *
 * Return format: bare arrays/objects, matching the style of
 * existing /sessions and /devices endpoints.
 */
export function userRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {

    // ── GET /api/v1/user/sessions ──────────────────────────
    // List sessions across ALL bound devices for the authenticated user.
    fastify.get('/user/sessions', { preHandler: [userTokenAuth()] }, async (req, reply) => {
      const userId = req.userAuth!.userId;
      const { history, windowId } = req.query as { history?: string; windowId?: string };
      const includeHistory = history === '1' || history === 'true';

      // Mirrors the logic in sessionRoutes GET /sessions but scoped to
      // all devices bound to this user (unbound_at IS NULL).
      const activeFilter = includeHistory
        ? sql`AND (s.status IN ('active', 'paused') OR (s.status = 'finished' AND s.finished_at > now() - interval '7 days'))`
        : sql`AND s.status = 'active'`;

      let query = sql`
        SELECT id, device_id, agent_type, status, cwd, project_name, metadata,
               started_at, finished_at, last_active_at, pending_count, device_name
        FROM (
          SELECT s.*,
                 (SELECT COUNT(*) FROM events e WHERE e.session_id = s.id AND e.pending = true)::int AS pending_count,
                 d.device_name,
                 row_number() OVER (
                   PARTITION BY s.device_id, s.agent_type, s.metadata->>'claudeSessionId'
                   ORDER BY CASE WHEN s.status = 'active' THEN 0 ELSE 1 END, s.last_active_at DESC
                 ) AS rn
          FROM sessions s
          JOIN device_bindings db ON s.device_id = db.device_id
          JOIN devices d ON d.id = db.device_id
          WHERE db.user_id = ${userId}
            AND db.unbound_at IS NULL
            AND coalesce(s.metadata->>'claudeSessionId', '') <> ''
            AND coalesce(s.metadata->>'hideFromMobileHistory', '') <> 'true'
            AND coalesce(s.metadata->>'source', '') IN ('transcript_attach', 'resume', 'opencode', 'opencode_attach', 'managed_codex_relay')
            ${activeFilter}
      `;
      if (windowId) {
        query = sql`${query} AND s.metadata->>'windowId' = ${windowId}`;
      }
      query = sql`${query}) ranked WHERE rn = 1 ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, last_active_at DESC`;
      return await query;
    });

    // ── GET /api/v1/user/sessions/:id ──────────────────────
    // Get session detail — only if the session belongs to a bound device.
    fastify.get('/user/sessions/:id', { preHandler: [userTokenAuth()] }, async (req, reply) => {
      const userId = req.userAuth!.userId;
      const { id } = req.params as { id: string };

      const [session] = await sql`
        SELECT s.*, d.device_name
        FROM sessions s
        JOIN device_bindings db ON s.device_id = db.device_id
        JOIN devices d ON d.id = db.device_id
        WHERE s.id = ${id}
          AND db.user_id = ${userId}
          AND db.unbound_at IS NULL
      `;
      if (!session) return reply.code(404).send({ error: 'not found' });
      return session;
    });

    // ── GET /api/v1/user/sessions/:id/events ────────────────
    // Get events for a session — only if the session belongs to a bound device.
    fastify.get('/user/sessions/:id/events', { preHandler: [userTokenAuth()] }, async (req, reply) => {
      const userId = req.userAuth!.userId;
      const { id } = req.params as { id: string };

      // Verify session ownership
      const [session] = await sql`
        SELECT s.id FROM sessions s
        JOIN device_bindings db ON s.device_id = db.device_id
        WHERE s.id = ${id}
          AND db.user_id = ${userId}
          AND db.unbound_at IS NULL
      `;
      if (!session) return reply.code(404).send({ error: 'not found' });

      const events = await sql`
        SELECT * FROM events WHERE session_id = ${id} ORDER BY created_at DESC
      `;
      return events;
    });

    // ── GET /api/v1/user/devices ────────────────────────────
    // List devices bound to the authenticated user (active bindings only).
    fastify.get('/user/devices', { preHandler: [userTokenAuth()] }, async (req) => {
      const userId = req.userAuth!.userId;

      const devices = await sql`
        SELECT d.id, d.device_name, db.bound_at
        FROM device_bindings db
        JOIN devices d ON d.id = db.device_id
        WHERE db.user_id = ${userId}
          AND db.unbound_at IS NULL
        ORDER BY db.bound_at DESC
      `;
      return devices;
    });

    // ── DELETE /api/v1/user/devices/:id ────────────────────
    // Unbind a device (soft delete + revoke tokens + notify WS clients).
    fastify.delete('/user/devices/:id', { preHandler: [userTokenAuth()] }, async (req, reply) => {
      const userId = req.userAuth!.userId;
      const { id: deviceId } = req.params as { id: string };

      const [binding] = await sql<{ unbound_at: string | null }[]>`
        UPDATE device_bindings
        SET unbound_at = now()
        WHERE device_id = ${deviceId}
          AND user_id = ${userId}
          AND unbound_at IS NULL
        RETURNING unbound_at
      `;
      if (!binding) {
        return reply.code(404).send({ error: 'device not found' });
      }

      await sql`UPDATE device_tokens SET revoked = true WHERE device_id = ${deviceId}`;

      // Close all mini program WS connections for this device
      const mpList = clientClients.get(deviceId);
      if (mpList) {
        for (const mp of mpList) {
          if (mp.socket.readyState === mp.socket.OPEN) {
            mp.socket.send(JSON.stringify({ type: 'auth_failed', code: 'DEVICE_UNBOUND' }));
            mp.socket.close(4001, 'device unbound');
          }
        }
        clientClients.delete(deviceId);
      }

      // Notify PC bridge if connected
      const pc = pcClients.get(deviceId);
      if (pc && pc.socket.readyState === pc.socket.OPEN) {
        pc.socket.send(JSON.stringify({ type: 'auth_failed', code: 'DEVICE_UNBOUND' }));
      }

      return { success: true, deviceId, unboundAt: binding.unbound_at };
    });

    // ── POST /api/v1/events/:id/approval-response ───────
    // HTTP approval endpoint for Telegram Mini App (and future HTTP clients).
    // Reuses the same validation logic as WS handleApprovalResponse.
    fastify.post('/events/:id/approval-response', { preHandler: [userTokenAuth()] }, async (req, reply) => {
      const userId = req.userAuth!.userId;
      const { id: eventId } = req.params as { id: string };
      const { decision, message } = req.body as { decision?: string; message?: string };

      if (!decision || !['approve', 'deny', 'pause', 'reply'].includes(decision)) {
        return reply.code(400).send({ error: 'invalid decision' });
      }

      const result = await validateAndApplyApproval(sql, {
        eventId,
        decision,
        message,
        userId,
      });

      if (!result.ok) {
        return reply.code(result.status ?? 500).send({ error: result.code });
      }

      return { success: true, eventId, decision };
    });
  };
}
