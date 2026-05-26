import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

export function deviceRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    // Generate pairing code
    fastify.post('/devices/pair', async (req, reply) => {
      // TODO: generate code, create device record
      reply.code(501).send({ error: 'not implemented' });
    });

    // Confirm pairing (mini program)
    fastify.post('/devices/confirm', async (req, reply) => {
      // TODO: validate code, bind device
      reply.code(501).send({ error: 'not implemented' });
    });

    // List bound devices
    fastify.get('/devices', async (req, reply) => {
      const devices = await sql`SELECT * FROM devices ORDER BY created_at DESC`;
      return devices;
    });

    // Unbind device
    fastify.delete('/devices/:id', async (req, reply) => {
      const { id } = req.params as { id: string };
      await sql`DELETE FROM devices WHERE id = ${id}`;
      return { success: true };
    });
  };
}
