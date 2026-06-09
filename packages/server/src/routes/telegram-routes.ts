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

      // Step 1: find pending events for Telegram users
      const candidates = await sql`
        SELECT e.id
        FROM events e
        JOIN sessions s ON e.session_id = s.id
        JOIN device_bindings db ON s.device_id = db.device_id AND db.unbound_at IS NULL
        JOIN auth_identities ai ON ai.user_id = db.user_id AND ai.provider = 'telegram'
        WHERE e.pending = true
          AND (e.type = 'approval_required' OR e.type = 'input_required')
          AND (e.data->>'telegramNotified' IS NULL OR e.data->>'telegramNotified' <> 'true')
        LIMIT 20
      `;
      if (!candidates.length) return [];

      // Step 2: mark them as notified and return
      const ids = candidates.map((r: any) => r.id);
      const events = await sql`
        UPDATE events e
        SET data = data || ${sql.json({ telegramNotified: 'true' })}
        WHERE e.id = ANY(${ids}::uuid[])
        RETURNING e.id, e.session_id, e.type, e.data->>'summary' as summary,
                  e.risk_level
      `;

      // Step 3: attach telegram_id to each event
      const sessionIds = [...new Set(events.map((r: any) => r.session_id))];
      const teleRows = sessionIds.length ? await sql`
        SELECT DISTINCT ON (s.id) s.id as session_id, ai.openid as telegram_id
        FROM sessions s
        JOIN device_bindings db ON s.device_id = db.device_id AND db.unbound_at IS NULL
        JOIN auth_identities ai ON ai.user_id = db.user_id AND ai.provider = 'telegram'
        WHERE s.id = ANY(${sessionIds}::uuid[])
      ` : [];
      const teleMap = new Map(teleRows.map((r: any) => [r.session_id, r.telegram_id]));

      return events.map((row: any) => ({
        eventId: row.id,
        sessionId: row.session_id,
        type: row.type,
        summary: row.summary || '',
        risk: row.risk_level || '',
        telegramId: teleMap.get(row.session_id) as string || '',
      }));

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
