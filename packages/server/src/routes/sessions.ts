import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

export function sessionRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    // Register new session (PC daemon)
    fastify.post('/sessions', async (req, reply) => {
      reply.code(501).send({ error: 'not implemented' });
    });

    // List sessions (mini program)
    fastify.get('/sessions', async (req, reply) => {
      const sessions = await sql`
        SELECT * FROM sessions ORDER BY last_active_at DESC
      `;
      return sessions;
    });

    // Get session detail
    fastify.get('/sessions/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      const [session] = await sql`SELECT * FROM sessions WHERE id = ${id}`;
      if (!session) return reply.code(404).send({ error: 'not found' });
      return session;
    });

    // Get session events
    fastify.get('/sessions/:id/events', async (req, reply) => {
      const { id } = req.params as { id: string };
      const events = await sql`
        SELECT * FROM events WHERE session_id = ${id} ORDER BY created_at DESC
      `;
      return events;
    });

    // Pause session
    fastify.post('/sessions/:id/pause', async (req, reply) => {
      reply.code(501).send({ error: 'not implemented' });
    });

    // Delete session
    fastify.delete('/sessions/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      await sql`DELETE FROM sessions WHERE id = ${id}`;
      return { success: true };
    });
  };
}
