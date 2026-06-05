import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { userTokenAuth } from '../auth/user-middleware.js';
import { signUserJwt } from '../auth/jwt.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { MVP_PRODUCT } from '../services/subscription/index.js';

/**
 * Auth routes — Phase 1 of the subscription system.
 *
 *   POST /api/v1/auth/wx-login
 *     Body: { code, provider?, openid? }   // openid is for mock mode only
 *     Returns: { userId, token, isNew }
 *
 *   POST /api/v1/auth/claim-device
 *     Headers: Authorization: Bearer <user_token>
 *     Body: { clientToken }
 *     Returns: { success, deviceId }
 *
 * Mock mode is enabled by setting WECHAT_APPID=mock. In that case
 * the server does NOT call WeChat's jscode2session — it accepts any
 * code and uses the `openid` field from the body (or a deterministic
 * value derived from the code if absent). This lets local dev and
 * tests run without real WeChat credentials.
 */

const WECHAT_JSCODE2SESSION = 'https://api.weixin.qq.com/sns/jscode2session';

interface WxCode2SessionResp {
  openid?: string;
  unionid?: string;
  errcode?: number;
  errmsg?: string;
}

async function exchangeWxCode(code: string, appid: string, secret: string): Promise<WxCode2SessionResp> {
  const url = `${WECHAT_JSCODE2SESSION}?appid=${encodeURIComponent(appid)}&secret=${encodeURIComponent(secret)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(5_000) });
  if (!resp.ok) return { errcode: -1, errmsg: `http ${resp.status}` };
  return (await resp.json()) as WxCode2SessionResp;
}

export function authRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    // ── POST /api/v1/auth/wx-login ──────────────────────────
    fastify.post('/auth/wx-login', {
      preHandler: rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'wxlogin' }),
    }, async (req, reply) => {
      const body = (req.body ?? {}) as { code?: string; provider?: string; openid?: string };
      const code = body.code;
      if (!code) return reply.code(400).send({ error: 'code required' });

      const appid = process.env.WECHAT_APPID;
      const secret = process.env.WECHAT_SECRET;
      const isMock = appid === 'mock';

      if (!appid || (!secret && !isMock)) {
        return reply.code(503).send({ error: 'wx_login not configured' });
      }

      let openid: string | undefined;
      let unionid: string | undefined;

      if (isMock) {
        // Local dev / tests: trust the body's openid (if any) or derive
        // a deterministic one from the code. NEVER ship this branch to prod.
        openid = body.openid || `mock-${code}`;
        unionid = undefined;
      } else {
        const wx = await exchangeWxCode(code, appid, secret!);
        if (wx.errcode || !wx.openid) {
          return reply.code(400).send({ error: 'invalid wx code', detail: wx.errmsg });
        }
        openid = wx.openid;
        unionid = wx.unionid;
      }

      // First-time vs returning is decided by a quick SELECT, with a
      // transaction + ON CONFLICT fallback for the very narrow race
      // where two requests for the same new (provider, openid) both
      // see "no row" simultaneously. The transaction's loser hits
      // ON CONFLICT on the identity insert, throws, and the whole
      // transaction (including its users row) is rolled back — so
      // we never leave an orphan users row behind. (The earlier CTE
      // design did: the CTE always materialised a fresh users row
      // before the conflict check ran.)
      const provider = body.provider === 'feishu' ? 'feishu' : 'wechat';

      const [existing] = await sql<{ user_id: number }[]>`
        SELECT user_id FROM auth_identities
        WHERE provider = ${provider} AND openid = ${openid}
      `;

      let userId: number;
      let isNew: boolean;
      if (existing) {
        userId = existing.user_id;
        isNew = false;
      } else {
        try {
          const result = await sql.begin(async (tx) => {
            const [u] = await tx<{ id: number }[]>`
              INSERT INTO users DEFAULT VALUES RETURNING id
            `;
            if (!u) throw new Error('users INSERT returned no row');
            const [ident] = await tx<{ user_id: number }[]>`
              INSERT INTO auth_identities (user_id, provider, openid, unionid)
              VALUES (${u.id}, ${provider}, ${openid}, ${unionid ?? null})
              ON CONFLICT (provider, openid) DO NOTHING
              RETURNING user_id
            `;
            if (!ident) {
              // Another concurrent request committed first. Throw
              // to roll back this transaction (which removes the
              // users row we just inserted) and let the caller
              // re-read the winner's identity.
              throw new Error('identity_conflict');
            }
            return ident.user_id;
          });
          userId = result;
          isNew = true;
        } catch (err) {
          if (err instanceof Error && err.message === 'identity_conflict') {
            const [winner] = await sql<{ user_id: number }[]>`
              SELECT user_id FROM auth_identities
              WHERE provider = ${provider} AND openid = ${openid}
            `;
            if (!winner) {
              // Should be impossible: the winning transaction just
              // committed. If the row really is gone, something is
              // deeply wrong (manual delete? bad migration?).
              throw new Error('auth_identities row vanished after conflict');
            }
            userId = winner.user_id;
            isNew = false;
          } else {
            throw err;
          }
        }
      }

      const token = signUserJwt(userId);
      return { userId, token, isNew };
    });

    // ── POST /api/v1/auth/claim-device ──────────────────────
    // Binds a single device (the one whose clientToken the caller
    // proves possession of) to the user identified by user_token.
    //
    // Atomic via INSERT ... ON CONFLICT DO NOTHING + RETURNING, so
    // two concurrent claims of the same device both serialise on
    // the device_id PK and exactly one INSERTs. The loser falls
    // through to the post-check below, which distinguishes:
    //   - same user   → 200 (idempotent retry, no error)
    //   - other user  → 403 (so the mini program can prompt unbind)
    //   - no row      → 500 (should be impossible after the conflict)
    fastify.post('/auth/claim-device', { preHandler: [userTokenAuth()] }, async (req, reply) => {
      const { clientToken } = (req.body ?? {}) as { clientToken?: string };
      if (!clientToken) return reply.code(400).send({ error: 'clientToken required' });

      const tokenHash = createHash('sha256').update(clientToken).digest('hex');
      const [tok] = await sql<{ device_id: string }[]>`
        SELECT device_id FROM device_tokens
        WHERE token_hash = ${tokenHash}
          AND token_type = 'client'
          AND revoked = false
          AND (expires_at IS NULL OR expires_at > now())
      `;
      if (!tok) return reply.code(404).send({ error: 'invalid clientToken' });

      const deviceId = tok.device_id;
      const userId = req.userAuth!.userId;

      const inserted = await sql<{ device_id: string }[]>`
        INSERT INTO device_bindings (device_id, user_id)
        VALUES (${deviceId}, ${userId})
        ON CONFLICT (device_id) DO NOTHING
        RETURNING device_id
      `;
      const isFirstBind = !!inserted[0];

      // Conflict: device already has a binding. Read the current
      // owner to decide the response.
      const [owner] = isFirstBind ? [] : await sql<{ user_id: number }[]>`
        SELECT user_id FROM device_bindings WHERE device_id = ${deviceId}
      `;
      if (!isFirstBind && !owner) {
        // Vanishing race: ON CONFLICT fired but the row is gone.
        // Treat as 500 — the next call will succeed.
        return reply.code(500).send({ error: 'binding_state_inconsistent' });
      }
      if (!isFirstBind && owner!.user_id !== userId) {
        return reply.code(403).send({ error: 'device bound to another user' });
      }

      // Success path (first bind OR same-user re-claim): auto-claim
      // a 14-day trial for this (user, product) pair. The ON CONFLICT
      // makes this a no-op on subsequent claims — the trial window
      // is set at first bind and never extended. (To extend, the
      // user redeems a code via /api/v1/redeem.)
      await sql`
        INSERT INTO trial_claims (user_id, product)
        VALUES (${userId}, ${MVP_PRODUCT})
        ON CONFLICT (user_id, product) DO NOTHING
      `;

      return {
        success: true,
        deviceId,
        ...(isFirstBind ? {} : { alreadyBound: true }),
      };
    });
  };
}
