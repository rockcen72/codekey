import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { deviceTokenAuth } from '../auth/middleware.js';

export function auditRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    // Get audit log (approvals history) — scoped to own device
    fastify.get('/audit', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const logs = await sql`
        SELECT a.* FROM approvals a
        JOIN sessions s ON a.session_id = s.id
        WHERE s.device_id = ${deviceAuth.deviceId}
        ORDER BY a.created_at DESC LIMIT 100
      `;
      return logs;
    });
  };
}
