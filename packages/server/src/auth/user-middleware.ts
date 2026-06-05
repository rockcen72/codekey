import type { FastifyRequest, FastifyReply } from 'fastify';
import { verifyUserJwt } from './jwt.js';

export interface UserAuth {
  userId: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    userAuth?: UserAuth;
  }
}

/**
 * Verify a `user_token` (JWT) from the Authorization header and
 * inject `req.userAuth.userId` for downstream handlers.
 *
 * 401 reasons are deliberately collapsed into a single
 * `unauthorized` response to avoid leaking which failure mode
 * (missing / bad sig / expired) the caller hit.
 */
export function userTokenAuth() {
  return async function (req: FastifyRequest, reply: FastifyReply) {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const token = auth.slice(7);
    const result = verifyUserJwt(token);
    if (!result.ok) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const userId = Number(result.claims.sub);
    if (!Number.isInteger(userId) || userId <= 0) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    req.userAuth = { userId };
  };
}
