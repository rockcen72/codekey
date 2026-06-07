import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { userTokenAuth } from '../auth/user-middleware.js';
import { signUserJwt } from '../auth/jwt.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { MVP_PRODUCT, invalidateEntitlement } from '../services/subscription/index.js';

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

async function findOrCreateUserForIdentity(
  sql: postgres.Sql,
  provider: string,
  openid: string,
  unionid?: string,
): Promise<{ userId: number; isNew: boolean }> {
  const [existing] = await sql<{ user_id: number }[]>`
    SELECT user_id FROM auth_identities
    WHERE provider = ${provider} AND openid = ${openid}
  `;

  if (existing) {
    return { userId: existing.user_id, isNew: false };
  }

  try {
    const userId = await sql.begin(async (tx) => {
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
        // Another concurrent request committed first. Throw to roll
        // back the user row we just inserted, then re-read below.
        throw new Error('identity_conflict');
      }
      return ident.user_id;
    });
    return { userId, isNew: true };
  } catch (err) {
    if (err instanceof Error && err.message === 'identity_conflict') {
      const [winner] = await sql<{ user_id: number }[]>`
        SELECT user_id FROM auth_identities
        WHERE provider = ${provider} AND openid = ${openid}
      `;
      if (!winner) {
        throw new Error('auth_identities row vanished after conflict');
      }
      return { userId: winner.user_id, isNew: false };
    }
    throw err;
  }
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

      const provider = body.provider === 'feishu' ? 'feishu' : 'wechat';
      const { userId, isNew } = await findOrCreateUserForIdentity(sql, provider, openid, unionid);

      const token = signUserJwt(userId);
      return { userId, token, isNew };
    });

    // ── POST /api/v1/auth/telegram ─────────────────────────
    // This endpoint trusts Cloudflare Worker to verify Telegram
    // initData first. It is protected by a shared server-side secret
    // so clients cannot spoof telegramId directly.
    fastify.post('/auth/telegram', {
      preHandler: rateLimit({ windowMs: 60_000, max: 60, keyPrefix: 'telegram-login' }),
    }, async (req, reply) => {
      const expectedSecret = process.env.TELEGRAM_LOGIN_SECRET;
      if (!expectedSecret) {
        return reply.code(503).send({ error: 'telegram_login not configured' });
      }

      const providedSecret = req.headers['x-codekey-telegram-secret'];
      if (providedSecret !== expectedSecret) {
        return reply.code(401).send({ error: 'unauthorized' });
      }

      const body = (req.body ?? {}) as {
        telegramId?: string | number;
        username?: string;
        firstName?: string;
        lastName?: string;
        authDate?: number;
      };
      if (body.telegramId === undefined || body.telegramId === null || body.telegramId === '') {
        return reply.code(400).send({ error: 'telegramId required' });
      }

      const openid = String(body.telegramId);
      if (!/^\d{1,32}$/.test(openid)) {
        return reply.code(400).send({ error: 'invalid telegramId' });
      }

      const { userId, isNew } = await findOrCreateUserForIdentity(sql, 'telegram', openid);
      const token = signUserJwt(userId);
      return {
        userId,
        token,
        isNew,
        provider: 'telegram',
        telegramId: openid,
      };
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
      // owner and unbound_at to decide the response.
      const [owner] = isFirstBind ? [] : await sql<{ user_id: number; unbound_at: string | null }[]>`
        SELECT user_id, unbound_at FROM device_bindings WHERE device_id = ${deviceId}
      `;
      if (!isFirstBind && !owner) {
        // Vanishing race: ON CONFLICT fired but the row is gone.
        // Treat as 500 — the next call will succeed.
        return reply.code(500).send({ error: 'binding_state_inconsistent' });
      }
      // owner.user_id is BIGSERIAL → postgres.js returns it as a string
      // (to preserve precision for >2^53). The middleware decodes the
      // JWT's sub claim with Number(), so userId is a JS number. Compare
      // both as numbers.
      if (!isFirstBind && Number(owner!.user_id) !== userId) {
        return reply.code(403).send({ error: 'device bound to another user' });
      }

      // Same-user re-pair after unbind: clear unbound_at so the
      // device reappears in all "WHERE unbound_at IS NULL" queries.
      // Guarded with unbound_at IS NOT NULL so a concurrent unbind
      // (which sets unbound_at = now()) is not silently overwritten.
      if (!isFirstBind && owner!.unbound_at) {
        await sql`
          UPDATE device_bindings
          SET unbound_at = NULL, bound_at = now()
          WHERE device_id = ${deviceId}
            AND user_id = ${userId}
            AND unbound_at IS NOT NULL
        `;
      }

      // Success path (first bind OR same-user re-claim): auto-claim
      // a 14-day trial for this (user, product) pair. The ON CONFLICT
      // makes this a no-op on subsequent claims — the trial window
      // is set at first bind and never extended. (To extend, the
      // user redeems a code via /api/v1/redeem.)
      const trialInserted = await sql<{ user_id: number }[]>`
        INSERT INTO trial_claims (user_id, product)
        VALUES (${userId}, ${MVP_PRODUCT})
        ON CONFLICT (user_id, product) DO NOTHING
        RETURNING user_id
      `;

      // Invalidate the entitlement cache whenever a new trial row
      // is actually written. Without this, a user who calls
      // /subscription BEFORE claim-device would see tier='free'
      // for up to 30s after the trial is granted, and the mini
      // program would not show the "Pro 试用中" card. (Review #7/#10.)
      if (trialInserted[0]) {
        invalidateEntitlement(userId, MVP_PRODUCT);
      }

      return {
        success: true,
        deviceId,
        ...(isFirstBind ? {} : { alreadyBound: true }),
      };
    });
  };
}
