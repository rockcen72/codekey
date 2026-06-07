import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { deviceTokenAuth } from '../auth/middleware.js';
import { clientClients, pairingClients } from '../ws/connection-registry.js';
import { rateLimit } from '../middleware/rate-limit.js';

export function deviceRoutes(sql: postgres.Sql) {
  return async function (fastify: FastifyInstance) {
    // PC initiates pairing (bootstrap or re-pair)
    // Bootstrap: no deviceId → create device. Re-pair: deviceId + secret_hash → validate.
    fastify.post('/devices/pair', async (req, reply) => {
      const { deviceId, deviceSecretHash, deviceName } = req.body as {
        deviceId?: string;
        deviceSecretHash?: string;
        deviceName?: string;
      };

      if (!deviceSecretHash) {
        return reply.code(400).send({ error: 'device_secret_hash required' });
      }

      let device;
      if (deviceId) {
        // Re-pair: must verify device_secret matches
        [device] = await sql`
          SELECT id, device_name, device_secret FROM devices WHERE id = ${deviceId}
        `;
        if (!device) {
          return reply.code(404).send({ error: 'DEVICE_NOT_FOUND' });
        }
        if (device.device_secret !== deviceSecretHash) {
          return reply.code(403).send({ error: 'device_secret mismatch' });
        }
      } else {
        // Bootstrap: create new device
        [device] = await sql`
          INSERT INTO devices (device_name, device_secret)
          VALUES (${deviceName ?? 'unknown'}, ${deviceSecretHash})
          RETURNING id, device_name
        `;
      }

      // Rate limit: same IP max 3 pair requests per 5 min
      const ip = req.ip;
      if (process.env.RATE_LIMIT_DISABLED !== '1') {
        const recentCount = await sql`
          SELECT COUNT(*) as count FROM pairing_codes
          WHERE ip_address = ${ip} AND created_at > now() - interval '5 minutes'
        `;
        if (recentCount[0].count >= 3) {
          return reply.code(429).send({ error: 'RATE_LIMITED' });
        }
      }

      // Generate pairing code (server-side only)
      const code = generatePairingCode();
      const codeHash = createHash('sha256').update(code).digest('hex');
      await sql`
        INSERT INTO pairing_codes (code_hash, device_id, ip_address, expires_at)
        VALUES (${codeHash}, ${device.id}, ${ip}, now() + interval '5 minutes')
      `;

      // PUBLIC_BASE_URL is set in start.sh / systemd EnvironmentFile.
      // server/index.ts and bundle-entry.ts both exit if it is missing,
      // so we can safely assume it's defined at request time.
      const pairUrl = `${process.env.PUBLIC_BASE_URL}/pair?code=${code}`;
      return { code, deviceId: device.id, expiresIn: 300, pairUrl };
    });

    // Mini program confirms pairing
    // After confirm, deviceToken is sent to PC via its pairing WebSocket
    // Rate limit: prevent brute-force pairing-code guessing — 30/min/IP is
    // generous for a real user (one code, one confirm) but stops a scanner.
    fastify.post('/devices/confirm', {
      preHandler: rateLimit({ windowMs: 60_000, max: 30, keyPrefix: 'confirm' }),
    }, async (req, reply) => {
      const { code, platform } = req.body as { code: string; platform?: string };
      if (!code) return reply.code(400).send({ error: 'code required' });
      if (
        platform !== undefined &&
        platform !== 'feishu' &&
        platform !== 'wechat' &&
        platform !== 'telegram'
      ) {
        return reply.code(400).send({ error: 'invalid platform' });
      }

      const codeHash = createHash('sha256').update(code).digest('hex');

      // Atomic one-time consumption: single UPDATE claims the code
      const [record] = await sql`
        UPDATE pairing_codes SET used_at = now()
        WHERE code_hash = ${codeHash}
          AND expires_at > now()
          AND used_at IS NULL
        RETURNING *
      `;
      if (!record) return reply.code(404).send({ error: 'invalid or expired code' });

      // Create client token (short-lived, for mini program)
      const clientToken = randomUUID();
      const clientTokenHash = createHash('sha256').update(clientToken).digest('hex');
      const clientLabel =
        platform === 'feishu'
          ? 'feishu-miniprogram'
          : platform === 'telegram'
            ? 'telegram-miniapp'
            : 'wechat-miniprogram';
      await sql`
        INSERT INTO device_tokens (device_id, token_type, token_hash, label, expires_at)
        VALUES (${record.device_id}, 'client', ${clientTokenHash}, ${clientLabel}, now() + interval '30 days')
      `;

      // Create device token (long-lived, for PC)
      const deviceToken = randomUUID();
      const deviceTokenHash = createHash('sha256').update(deviceToken).digest('hex');
      await sql`
        INSERT INTO device_tokens (device_id, token_type, token_hash, label, expires_at)
        VALUES (${record.device_id}, 'device', ${deviceTokenHash}, 'pc-daemon', now() + interval '365 days')
      `;

      // Send deviceToken to PC via its pairing WS connection
      const pcWs = pairingClients.get(record.device_id);
      if (pcWs && pcWs.socket.readyState === pcWs.socket.OPEN) {
        pcWs.socket.send(JSON.stringify({
          type: 'device_token',
          payload: { deviceToken, deviceId: record.device_id },
        }));
      }

      return {
        clientToken,
        deviceId: record.device_id,
      };
    });

    // List bound devices (scoped to own device)
    fastify.get('/devices', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const devices = await sql`SELECT * FROM devices WHERE id = ${deviceAuth.deviceId}`;
      return devices;
    });

    // Unbind device (must match token's device)
    fastify.delete('/devices/:id', { preHandler: [deviceTokenAuth(sql)] }, async (req, reply) => {
      const { deviceAuth } = req as unknown as { deviceAuth: { deviceId: string } };
      const { id } = req.params as { id: string };
      if (id !== deviceAuth.deviceId) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      // Revoke all tokens so mini programs get 401 on next API call
      await sql`UPDATE device_tokens SET revoked = true WHERE device_id = ${id}`;
      await sql`DELETE FROM devices WHERE id = ${id}`;

      // Close all mini program WS connections — they'll see auth_failed
      const mpList = clientClients.get(id);
      if (mpList) {
        for (const mp of mpList) {
          if (mp.socket.readyState === mp.socket.OPEN) {
            mp.socket.send(JSON.stringify({ type: 'auth_failed', code: 'DEVICE_DELETED' }));
            mp.socket.close(4001, 'device deleted');
          }
        }
        clientClients.delete(id);
      }
      return { success: true };
    });
  };
}

function generatePairingCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[bytes[i] % chars.length];
  }
  return code;
}
