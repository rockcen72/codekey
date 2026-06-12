import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deviceTokenAuth } from '../auth/middleware.js';
import { clientClients, pcClients, pairingClients } from '../ws/connection-registry.js';
import { rateLimit } from '../middleware/rate-limit.js';

export function deviceRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    fastify.post('/devices/pair', async (req, reply) => {
      const { deviceId, deviceSecretHash, deviceName } = req.body as {
        deviceId?: string;
        deviceSecretHash?: string;
        deviceName?: string;
        desktopInstallId?: string;
      };
      if (!deviceSecretHash) return reply.code(400).send({ error: 'device_secret_hash required' });
      const desktopInstallId = normalizeDesktopInstallId((req.body as { desktopInstallId?: unknown }).desktopInstallId);
      let device;
      if (deviceId) {
        [device] = await sql`SELECT id, device_name, device_secret FROM devices WHERE id = ${deviceId}`;
        if (!device) return reply.code(404).send({ error: 'DEVICE_NOT_FOUND' });
        if (device.device_secret !== deviceSecretHash) return reply.code(403).send({ error: 'device_secret mismatch' });
      } else {
        [device] = await sql`INSERT INTO devices (device_name, device_secret, desktop_install_id) VALUES (${deviceName ?? 'unknown'}, ${deviceSecretHash}, ${desktopInstallId ?? null}) RETURNING id, device_name`;
      }
      if (desktopInstallId) {
        await sql`UPDATE devices SET desktop_install_id = ${desktopInstallId} WHERE id = ${device.id}`;
        await sql`
          INSERT INTO device_subscriptions (device_id, product, plan, expires_at, source)
          SELECT DISTINCT ON (ds.product) ${device.id}, ds.product, ds.plan, ds.expires_at, ds.source
          FROM device_subscriptions ds
          JOIN devices d ON d.id = ds.device_id
          WHERE d.desktop_install_id = ${desktopInstallId}
            AND ds.device_id <> ${device.id}
          ORDER BY ds.product, ds.expires_at DESC
          ON CONFLICT (device_id, product) DO UPDATE SET
            plan = CASE
              WHEN EXCLUDED.expires_at > device_subscriptions.expires_at THEN EXCLUDED.plan
              ELSE device_subscriptions.plan
            END,
            expires_at = GREATEST(device_subscriptions.expires_at, EXCLUDED.expires_at),
            source = CASE
              WHEN EXCLUDED.expires_at > device_subscriptions.expires_at THEN EXCLUDED.source
              ELSE device_subscriptions.source
            END,
            updated_at = now()
        `;
      }
      const ip = req.ip;
      if (process.env.RATE_LIMIT_DISABLED !== '1') {
        const recentCount = await sql`SELECT COUNT(*) as count FROM pairing_codes WHERE ip_address = ${ip} AND created_at > now() - interval '5 minutes'`;
        if (recentCount[0].count >= 20) return reply.code(429).send({ error: 'RATE_LIMITED' });
      }
      const code = generatePairingCode();
      const codeHash = createHash('sha256').update(code).digest('hex');
      await sql`INSERT INTO pairing_codes (code_hash, device_id, ip_address, expires_at) VALUES (${codeHash}, ${device.id}, ${ip}, now() + interval '5 minutes')`;
      const pairUrl = `${process.env.PUBLIC_BASE_URL}/pair?code=${code}`;
      return { code, deviceId: device.id, expiresIn: 300, pairUrl };
    });

    fastify.post('/devices/confirm', { preHandler: rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'confirm' }) }, async (req, reply) => {
      const { code, platform } = req.body as { code: string; platform?: string };
      if (!code) return reply.code(400).send({ error: 'code required' });
      if (platform !== undefined && platform !== 'feishu' && platform !== 'wechat' && platform !== 'telegram') return reply.code(400).send({ error: 'invalid platform' });
      const codeHash = createHash('sha256').update(code).digest('hex');
      const [record] = await sql`SELECT * FROM pairing_codes WHERE code_hash = ${codeHash} AND expires_at > now() AND used_at IS NULL LIMIT 1`;
      if (!record) return reply.code(404).send({ error: 'invalid or expired code' });
      let pcWs = pairingClients.get(record.device_id);
      const waitUntil = Date.now() + 8_000;
      while ((!pcWs || pcWs.socket.readyState !== pcWs.socket.OPEN) && Date.now() < waitUntil) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        pcWs = pairingClients.get(record.device_id);
      }
      if (!pcWs || pcWs.socket.readyState !== pcWs.socket.OPEN) {
        return reply.code(409).send({ error: 'desktop not waiting for pairing' });
      }
      const [claimed] = await sql`UPDATE pairing_codes SET used_at = now() WHERE id = ${record.id} AND used_at IS NULL RETURNING *`;
      if (!claimed) return reply.code(404).send({ error: 'invalid or expired code' });
      const clientToken = randomUUID();
      const clientTokenHash = createHash('sha256').update(clientToken).digest('hex');
      const clientLabel = platform === 'feishu' ? 'feishu-miniprogram' : platform === 'telegram' ? 'telegram-miniapp' : 'wechat-miniprogram';
      await sql`INSERT INTO device_tokens (device_id, token_type, token_hash, label, expires_at) VALUES (${record.device_id}, 'client', ${clientTokenHash}, ${clientLabel}, now() + interval '30 days')`;
      const deviceToken = randomUUID();
      const deviceTokenHash = createHash('sha256').update(deviceToken).digest('hex');
      await sql`INSERT INTO device_tokens (device_id, token_type, token_hash, label, expires_at) VALUES (${record.device_id}, 'device', ${deviceTokenHash}, 'pc-daemon', now() + interval '365 days')`;
      pcWs.socket.send(JSON.stringify({ type: 'device_token', payload: { deviceToken, deviceId: record.device_id } }));
      return { clientToken, deviceId: record.device_id, desktopNotified: true };
    });

    fastify.get('/devices', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      return await sql`SELECT * FROM devices WHERE id = ${deviceAuth.deviceId}`;
    });

    // Unbind device. In single-device mode, unbinding the PC device also
    // revokes all active bindings for the owning user, so mini-program
    // clients (Telegram/WeChat) receive auth_failed via WS.
    fastify.delete('/devices/:id', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { id } = req.params as { id: string };
      if (id !== deviceAuth.deviceId) return reply.code(403).send({ error: 'forbidden' });

      const [binding] = await sql<{ user_id: number }[]>`SELECT user_id FROM device_bindings WHERE device_id = ${id} AND unbound_at IS NULL LIMIT 1`;
      if (binding) {
        const affected = await sql<{ device_id: string }[]>`UPDATE device_bindings SET unbound_at = now() WHERE user_id = ${binding.user_id} AND unbound_at IS NULL RETURNING device_id`;
        if (affected.length > 0) {
          const ids = affected.map((r: any) => r.device_id);
          await sql`UPDATE device_tokens SET revoked = true WHERE device_id = ANY(${sql.array(ids)}::uuid[])`;
          for (const aid of ids) {
            const mpList = clientClients.get(aid);
            if (mpList) {
              for (const mp of mpList) {
                if (mp.socket.readyState === mp.socket.OPEN) {
                  try { mp.socket.send(JSON.stringify({ type: 'auth_failed', code: 'DEVICE_UNBOUND' })); } catch {}
                  try { mp.socket.close(4001, 'device unbound'); } catch {}
                }
              }
              clientClients.delete(aid);
            }
            const pc = pcClients.get(aid);
            if (pc && pc.socket.readyState === pc.socket.OPEN) {
              try { pc.socket.send(JSON.stringify({ type: 'auth_failed', code: 'DEVICE_UNBOUND' })); } catch {}
            }
          }
        }
      }
      await sql`DELETE FROM devices WHERE id = ${id}`;
      return { success: true };
    });
  };
}

function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
}

function normalizeDesktopInstallId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(trimmed)) return null;
  return trimmed;
}
