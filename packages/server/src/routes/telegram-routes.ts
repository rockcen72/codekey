import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

/**
 * Telegram notification polling routes.
 * The Cloudflare Worker polls these endpoints since it cannot be reached
 * from the relay server (Tencent Cloud egress restrictions).
 * Protected by a shared secret (TELEGRAM_LOGIN_SECRET) passed in header.
 */
export function telegramRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {

    // ── GET /api/v1/telegram/pending-events ─────────
    // Returns pending interactive events from devices bound to Telegram users,
    // along with the user's Telegram chat ID. Marks them as notified so they
    // are not returned again.
    fastify.get('/telegram/pending-events', async (req, reply) => {
      const secret = req.headers['x-codekey-telegram-secret'];
      if (secret !== process.env.TELEGRAM_LOGIN_SECRET) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const events = await sql`
        UPDATE events e
        SET data = data || ${sql.json({ telegramNotified: 'true' })}
        FROM sessions s, device_bindings db, auth_identities ai
        WHERE e.session_id = s.id
          AND s.device_id = db.device_id AND db.unbound_at IS NULL
          AND ai.user_id = db.user_id AND ai.provider = 'telegram'
          AND e.pending = true
          AND (e.type = 'approval_required' OR e.type = 'input_required')
          AND (e.data->>'telegramNotified' IS NULL OR e.data->>'telegramNotified' <> 'true')
        RETURNING e.id, e.session_id, e.type, e.data->>'summary' as summary,
                  e.risk_level, ai.openid as telegram_id
        LIMIT 20
      `;

      return events.map((row: any) => ({
        eventId: row.id,
        sessionId: row.session_id,
        type: row.type,
        summary: row.summary || '',
        risk: row.risk_level || '',
        telegramId: row.telegram_id as string,
      }));
    });
  };
}
