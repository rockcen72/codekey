import type { FastifyRequest, FastifyReply } from 'fastify';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';

export interface DeviceAuth {
  deviceId: string;
  tokenType: string;
}

/**
 * Verify a Bearer token from the Authorization header.
 * Accepts any valid (device or client) token.
 */
export function tokenAuth(sql: postgres.Sql) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const token = auth.slice(7);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [tok] = await sql`
      SELECT device_id, token_type FROM device_tokens
      WHERE token_hash = ${tokenHash}
        AND revoked = false
        AND (expires_at IS NULL OR expires_at > now())
    `;
    if (!tok) {
      return reply.code(401).send({ error: 'invalid token' });
    }
    (req as unknown as { deviceAuth: DeviceAuth }).deviceAuth = {
      deviceId: tok.device_id,
      tokenType: tok.token_type,
    };
  };
}

/**
 * Verify a Bearer token — only accepts 'device' type tokens.
 */
export function deviceTokenAuth(sql: postgres.Sql) {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const token = auth.slice(7);
    const tokenHash = createHash('sha256').update(token).digest('hex');
    const [tok] = await sql`
      SELECT device_id, token_type FROM device_tokens
      WHERE token_hash = ${tokenHash}
        AND token_type = 'device'
        AND revoked = false
        AND (expires_at IS NULL OR expires_at > now())
    `;
    if (!tok) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    (req as unknown as { deviceAuth: DeviceAuth }).deviceAuth = {
      deviceId: tok.device_id,
      tokenType: tok.token_type,
    };
  };
}
