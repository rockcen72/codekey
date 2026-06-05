/**
 * Dev-only seed routes for testing subscription UI on a real device.
 *
 * Mounts only when `isDevSeedEnabled()` returns true (see config/dev-seed.ts).
 * Otherwise this module throws at load time — the import() in app.ts never
 * resolves to a registerable plugin.
 *
 * Endpoints:
 *   POST /api/v1/dev/invalidate-entitlement   body: {userId, product?}
 *   GET  /api/v1/dev/usage/:userId            returns UsageSnapshot
 *   POST /api/v1/dev/bind-device              body: {deviceId, userId}
 *   POST /api/v1/dev/clear-usage              body: {userId, period?}
 *
 * Both require the X-Dev-Secret header to match DEV_SEED_SECRET. This is
 * the second layer of defence: even if the module somehow loaded with a
 * weak config, an attacker still needs the secret.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type postgres from 'postgres';
import { invalidateEntitlement } from '../services/subscription/index.js';
import { getUsage } from '../services/quota.js';
import { getDevSeedConfig } from '../config/dev-seed.js';

const config = getDevSeedConfig();
if (!config.enabled) {
  throw new Error(
    `dev seed routes refused to load: ${config.reason ?? 'disabled'}. ` +
      'Set DEV_SEED_SECRET (>=32 chars) + DEV_SEED_ENABLED=1, and either ' +
      'NODE_ENV!=production or ALLOW_DEV_SEED_IN_PRODUCTION=1.',
  );
}
const DEV_SECRET = config.secret!;

export function devSeedRoutes(sql: postgres.Sql) {
  return async (app: FastifyInstance) => {
    // Defence in depth: every dev route must carry a matching X-Dev-Secret.
    // The module already throws if secret is empty, but we re-check the
    // header on every request to be safe.
    async function requireSecret(req: FastifyRequest, reply: FastifyReply) {
      if (req.headers['x-dev-secret'] !== DEV_SECRET) {
        return reply.code(403).send({ error: 'forbidden' });
      }
    }

    app.post<{ Body: { userId?: number; product?: string } }>(
      '/dev/invalidate-entitlement',
      { preHandler: requireSecret },
      async (req) => {
        const { userId, product } = req.body ?? {};
        if (typeof userId !== 'number' || !Number.isFinite(userId)) {
          return { ok: false, error: 'userId (number) required' };
        }
        invalidateEntitlement(userId, product ?? 'codekey');
        return { ok: true, userId, product: product ?? 'codekey' };
      },
    );

    app.get<{ Params: { userId: string } }>(
      '/dev/usage/:userId',
      { preHandler: requireSecret },
      async (req, reply) => {
        const userId = Number(req.params.userId);
        if (!Number.isFinite(userId)) {
          return reply.code(400).send({ error: 'userId must be numeric' });
        }
        return getUsage(sql, userId);
      },
    );

    // Bind a device to a user (skips the full pairing + claim-device flow).
    // Used to test quota gate with a fresh device without going through
    // /auth/claim-device (which needs the user's user_token).
    app.post<{ Body: { deviceId?: string; userId?: number } }>(
      '/dev/bind-device',
      { preHandler: requireSecret },
      async (req, reply) => {
        const { deviceId, userId } = req.body ?? {};
        if (typeof deviceId !== 'string' || !deviceId) {
          return reply.code(400).send({ error: 'deviceId (string) required' });
        }
        if (typeof userId !== 'number' || !Number.isFinite(userId)) {
          return reply.code(400).send({ error: 'userId (number) required' });
        }
        await sql`
          INSERT INTO device_bindings (device_id, user_id, bound_at)
          VALUES (${deviceId}, ${userId}, now())
        `;
        return { ok: true, deviceId, userId };
      },
    );

    // Reset the approval_usage counter for a user. Used to test the
    // free-tier flow at 0/50 (gate allows) vs 50/50 (gate blocks).
    app.post<{ Body: { userId?: number; period?: string } }>(
      '/dev/clear-usage',
      { preHandler: requireSecret },
      async (req) => {
        const { userId, period } = req.body ?? {};
        if (typeof userId !== 'number' || !Number.isFinite(userId)) {
          return { ok: false, error: 'userId (number) required' };
        }
        await sql`
          DELETE FROM approval_usage
          WHERE user_id = ${userId} AND product = 'codekey'
            ${period ? sql`AND period = ${period}` : sql``}
        `;
        return { ok: true, userId, period: period ?? 'all' };
      },
    );
  };
}
