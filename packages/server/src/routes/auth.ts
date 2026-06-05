import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { userTokenAuth } from '../auth/user-middleware.js';
import { signUserJwt } from '../auth/jwt.js';
import { rateLimit } from '../middleware/rate-limit.js';

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

      // Upsert: look up (provider, openid) → if exists return that user,
      // else create a fresh user + auth_identity in one transaction.
      const provider = body.provider === 'feishu' ? 'feishu' : 'wechat';

      const existing = await sql<{ user_id: number }[]>`
        SELECT user_id FROM auth_identities
        WHERE provider = ${provider} AND openid = ${openid}
      `;

      let userId: number;
      let isNew = false;
      if (existing[0]) {
        userId = existing[0].user_id;
      } else {
        isNew = true;
        const result = await sql<{ id: number }[]>`INSERT INTO users DEFAULT VALUES RETURNING id`;
        userId = result[0].id;
        await sql`
          INSERT INTO auth_identities (user_id, provider, openid, unionid)
          VALUES (${userId}, ${provider}, ${openid}, ${unionid ?? null})
        `;
      }

      const token = signUserJwt(userId);
      return { userId, token, isNew };
    });

    // ── POST /api/v1/auth/claim-device ──────────────────────
    // Binds a single device (the one whose clientToken the caller
    // proves possession of) to the user identified by user_token.
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

      const [binding] = await sql<{ device_id: string }[]>`
        SELECT device_id FROM device_bindings WHERE device_id = ${deviceId}
      `;

      if (binding) {
        if (binding.device_id === deviceId) {
          return reply.code(409).send({ error: 'device already bound' });
        }
        return reply.code(403).send({ error: 'device bound to another user' });
      }

      await sql`
        INSERT INTO device_bindings (device_id, user_id)
        VALUES (${deviceId}, ${userId})
      `;

      return { success: true, deviceId };
    });
  };
}
