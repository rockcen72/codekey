import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createHash } from 'node:crypto';
import { userTokenAuth } from '../auth/user-middleware.js';
import { signUserJwt } from '../auth/jwt.js';
import { rateLimit } from '../middleware/rate-limit.js';
import { MVP_PRODUCT, invalidateEntitlement } from '../services/subscription/index.js';
import { replaceActiveDeviceBinding, DeviceBoundToOtherUser } from '../db/device-binding.js';
import { clientClients, pcClients } from '../ws/connection-registry.js';

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

/** 事务外发送 WS 通知给被替换的旧设备。 */
function notifyDeviceReplaced(oldDeviceId: string): void {
  // 小程序 WS
  const oldMpList = clientClients.get(oldDeviceId);
  if (oldMpList) {
    for (const mp of oldMpList) {
      if (mp.socket.readyState === mp.socket.OPEN) {
        try {
          mp.socket.send(JSON.stringify({
            type: 'auth_failed',
            payload: { code: 'DEVICE_REPLACED' },
          }));
        } catch {}
        try { mp.socket.close(4001, 'device replaced'); } catch {}
      }
    }
    clientClients.delete(oldDeviceId);
  }

  // PC bridge
  const oldPc = pcClients.get(oldDeviceId);
  if (oldPc && oldPc.socket.readyState === oldPc.socket.OPEN) {
    try {
      oldPc.socket.send(JSON.stringify({
        type: 'auth_failed',
        code: 'DEVICE_REPLACED',
      }));
    } catch {}
  }
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
    // Single-device mode: binds a device to the user, atomically
    // replacing any previous active binding. Uses a single transaction
    // to ensure the replace + bind + trial insert are ACID.
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

      let replaced: string[] = [];
      try {
        const result = await sql.begin(async (tx) => {
          // 1. 原子替换旧设备绑定
          const bindingResult = await replaceActiveDeviceBinding(tx, userId, deviceId);
          replaced = bindingResult.replaced;

          // 2. INSERT 新设备绑定（或 upsert 现有行确保 active）
          //    用 RETURNING 验证 user_id 归属，防并发竞争导致"假成功"
          const [bound] = await tx<{ user_id: number }[]>`
            INSERT INTO device_bindings (device_id, user_id)
            VALUES (${deviceId}, ${userId})
            ON CONFLICT (device_id) DO UPDATE SET
              unbound_at = NULL,
              bound_at = now()
            RETURNING user_id
          `;
          // 并发下另一个事务先提交了不同用户的 binding，DO UPDATE 不覆盖
          // user_id，此处捕获归属不匹配
          if (Number(bound.user_id) !== userId) {
            throw new DeviceBoundToOtherUser();
          }

          // 3. trial_claims（ON CONFLICT DO NOTHING 保证幂等）
          const trialInserted = await tx<{ user_id: number }[]>`
            INSERT INTO trial_claims (user_id, product)
            VALUES (${userId}, ${MVP_PRODUCT})
            ON CONFLICT (user_id, product) DO NOTHING
            RETURNING user_id
          `;

          return { trialInserted: trialInserted.length > 0 };
        });

        // 事务已 COMMIT — 此时才发送 WS 通知
        for (const oldId of replaced) {
          notifyDeviceReplaced(oldId);
        }

        if (result.trialInserted) {
          invalidateEntitlement(userId, MVP_PRODUCT);
        }

        return {
          success: true,
          deviceId,
          ...(replaced.length > 0 ? { replaced: true } : {}),
        };
      } catch (err) {
        if (err instanceof DeviceBoundToOtherUser) {
          return reply.code(403).send({ error: err.message });
        }
        throw err;
      }
    });
  };
}
