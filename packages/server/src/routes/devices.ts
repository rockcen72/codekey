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
      };
      if (!deviceSecretHash) return reply.code(400).send({ error: 'device_secret_hash required' });
      let device;
      if (deviceId) {
        [device] = await sql`SELECT id, device_name, device_secret FROM devices WHERE id = ${deviceId}`;
        if (!device) return reply.code(404).send({ error: 'DEVICE_NOT_FOUND' });
        if (device.device_secret !== deviceSecretHash) return reply.code(403).send({ error: 'device_secret mismatch' });
      } else {
        [device] = await sql`INSERT INTO devices (device_name, device_secret) VALUES (${deviceName ?? 'unknown'}, ${deviceSecretHash}) RETURNING id, device_name`;
      }
      const ip = req.ip;
      if (process.env.RATE_LIMIT_DISABLED !== '1') {
        const recentCount = await sql`SELECT COUNT(*) as count FROM pairing_codes WHERE ip_address = ${ip} AND created_at > now() - interval '5 minutes'`;
        if (recentCount[0].count >= 3) return reply.code(429).send({ error: 'RATE_LIMITED' });
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
      const [record] = await sql`UPDATE pairing_codes SET used_at = now() WHERE code_hash = ${codeHash} AND expires_at > now() AND used_at IS NULL RETURNING *`;
      if (!record) return reply.code(404).send({ error: 'invalid or expired code' });
      const clientToken = randomUUID();
      const clientTokenHash = createHash('sha256').update(clientToken).digest('hex');
      const clientLabel = platform === 'feishu' ? 'feishu-miniprogram' : platform === 'telegram' ? 'telegram-miniapp' : 'wechat-miniprogram';
      await sql`INSERT INTO device_tokens (device_id, token_type, token_hash, label, expires_at) VALUES (${record.device_id}, 'client', ${clientTokenHash}, ${clientLabel}, now() + interval '30 days')`;
      const deviceToken = randomUUID();
      const deviceTokenHash = createHash('sha256').update(deviceToken).digest('hex');
      await sql`INSERT INTO device_tokens (device_id, token_type, token_hash, label, expires_at) VALUES (${record.device_id}, 'device', ${deviceTokenHash}, 'pc-daemon', now() + interval '365 days')`;
      const pcWs = pairingClients.get(record.device_id);
      if (pcWs && pcWs.socket.readyState === pcWs.socket.OPEN) pcWs.socket.send(JSON.stringify({ type: 'device_token', payload: { deviceToken, deviceId: record.device_id } }));
      return { clientToken, deviceId: record.device_id };
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
