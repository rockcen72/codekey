import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

export function auditRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    // Get audit log (approvals history)
    fastify.get('/audit', async (req, reply) => {
      const logs = await sql`
        SELECT * FROM approvals ORDER BY created_at DESC LIMIT 100
      `;
      return logs;
    });
  };
}
