import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  pcClients, clientClients, pairingClients,
  type WsClient, type PairingClient,
} from './connection-registry.js';

export function wsHandler(sql: postgres.Sql) {
  return function (socket: WebSocket, req: FastifyRequest) {
    const url = new URL(req.url, 'http://localhost');
    const deviceId = url.searchParams.get('device_id');
    const deviceSecret = url.searchParams.get('device_secret');
    const token = url.searchParams.get('token');

    if (!deviceId) {
      socket.close(4001, 'missing device_id');
      return;
    }

    // Auth: device_secret (pairing flow) OR device_token (runtime)
    if (deviceSecret) {
      // Pairing mode: validate device_secret hash
      const secretHash = createHash('sha256').update(deviceSecret).digest('hex');
      sql`SELECT id FROM devices WHERE id = ${deviceId} AND device_secret = ${secretHash}`
        .then((rows) => {
          if (rows.length === 0) {
            socket.close(4001, 'invalid device_secret');
            return;
          }
          pairingClients.set(deviceId, { socket, deviceId });
          socket.on('close', () => pairingClients.delete(deviceId));
          socket.send(JSON.stringify({ type: 'pairing_ready', deviceId }));
        });
      return;
    }

    if (!token) {
      socket.close(4001, 'missing device_secret or token');
      return;
    }

    // Runtime mode: validate device_token
    const tokenHash = createHash('sha256').update(token).digest('hex');
    sql`
      SELECT * FROM device_tokens
      WHERE token_hash = ${tokenHash}
        AND device_id = ${deviceId}
        AND revoked = false
        AND (expires_at IS NULL OR expires_at > now())
    `.then((rows) => {
      if (rows.length === 0) {
        socket.close(4001, 'invalid token');
        return;
      }

      const tok = rows[0] as { token_type: string };

      if (tok.token_type === 'device') {
        // PC daemon connection
        const client: WsClient = { socket, deviceId, tokenType: 'device' };
        pcClients.set(deviceId, client);

        socket.on('message', async (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'ping') {
              socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
              return;
            }
            if (msg.type === 'register_session') {
              // PC registers a session so events can reference it via FK
              const [sessionRecord] = await sql`
                INSERT INTO sessions (device_id, agent_type, status, metadata)
                VALUES (${deviceId}, ${msg.payload.agentType ?? 'claude-code'}, 'active', '{}')
                RETURNING id
              `;
              client.sessionId = sessionRecord.id;
              socket.send(JSON.stringify({
                type: 'session_registered',
                payload: { sessionId: sessionRecord.id },
              }));
              return;
            }
            if (msg.type === 'event') {
              // Validate session was registered
              if (!client.sessionId) {
                socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_REGISTERED' }));
                return;
              }
              // Store event, generate server eventId
              const [event] = await sql`
                INSERT INTO events (session_id, type, data, risk_level, pending)
                VALUES (${client.sessionId}, ${msg.payload.eventType},
                        ${JSON.stringify(msg.payload.data)}, ${msg.payload.data.risk ?? null}, true)
                RETURNING id
              `;

              // Send event_ack with server-generated eventId
              socket.send(JSON.stringify({
                type: 'event_ack',
                payload: {
                  clientEventId: msg.payload.clientEventId ?? null,
                  serverEventId: event.id,
                },
              }));

              // Push to mini program clients with serverEventId
              const mpClients = clientClients.get(deviceId);
              if (mpClients) {
                for (const mp of mpClients) {
                  if (mp.socket.readyState === mp.socket.OPEN) {
                    mp.socket.send(JSON.stringify({
                      type: 'event_push',
                      payload: {
                        sessionId: msg.payload.sessionId,
                        eventId: event.id,
                        eventType: msg.payload.eventType,
                        summary: msg.payload.data.summary ?? msg.payload.data.command ?? '',
                        risk: msg.payload.data.risk,
                      },
                    }));
                  }
                }
              }
            }
          } catch (err) {
            console.error('WS message error (device):', err);
          }
        });

        socket.on('close', () => pcClients.delete(deviceId));

      } else if (tok.token_type === 'client') {
        // Mini program connection
        const client: WsClient = { socket, deviceId, tokenType: 'client' };
        if (!clientClients.has(deviceId)) {
          clientClients.set(deviceId, new Set());
        }
        clientClients.get(deviceId)!.add(client);

        socket.on('message', async (raw) => {
          try {
            const msg = JSON.parse(raw.toString());
            if (msg.type === 'ping') {
              socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
              return;
            }
            if (msg.type === 'approval_response') {
              // Atomically claim the event (only succeeds if still pending).
              // This prevents race conditions from concurrent approval requests.
              // OPTIMIZATION NOTE: ownership/risk checks could be moved before the atomic
              // UPDATE to avoid leaving events in a claimed-but-reverted state on check
              // failure. Current approach is safe (reverts on failure) but for high-traffic
              // scenarios, pre-check + atomic UPDATE improves reliability.
              const [claimed] = await sql`
                UPDATE events SET pending = false, decision = ${msg.payload.decision},
                  responded_at = now() WHERE id = ${msg.payload.eventId} AND pending = true
                RETURNING *
              `;
              if (!claimed) {
                socket.send(JSON.stringify({ type: 'error', code: 'ALREADY_RESPONDED' }));
                return;
              }

              // Server-side ownership check: mini program must belong to same device
              const [sessionRec] = await sql`
                SELECT device_id FROM sessions WHERE id = ${claimed.session_id}
              `;
              if (!sessionRec || sessionRec.device_id !== deviceId) {
                await sql`UPDATE events SET pending = true WHERE id = ${claimed.id}`;
                socket.send(JSON.stringify({ type: 'error', code: 'ACCESS_DENIED' }));
                return;
              }

              // Server-side risk enforcement
              const ALLOWED_DECISIONS: Record<string, string[]> = {
                low: ['approve', 'deny', 'pause', 'reply'],
                medium: ['approve', 'deny', 'pause', 'reply'],
                high: ['deny', 'pause', 'reply'],
                critical: ['deny', 'pause'],
                unknown: ['deny', 'pause', 'reply'],
              };
              const allowed = (ALLOWED_DECISIONS[claimed.risk_level as string] ?? ['deny', 'pause']);
              if (!allowed.includes(msg.payload.decision)) {
                await sql`UPDATE events SET pending = true WHERE id = ${claimed.id}`;
                socket.send(JSON.stringify({ type: 'error', code: 'RISK_TOO_HIGH' }));
                return;
              }

              await sql`
                INSERT INTO approvals (event_id, session_id, decision, command, risk_level, message)
                VALUES (${claimed.id}, ${claimed.session_id}, ${msg.payload.decision},
                        ${claimed.data?.command ?? null}, ${claimed.risk_level},
                        ${msg.payload.message ?? null})
              `;

              // Forward to PC daemon
              const pc = pcClients.get(deviceId);
              if (pc && pc.socket.readyState === pc.socket.OPEN) {
                pc.socket.send(JSON.stringify({
                  type: 'approval_forward',
                  payload: {
                    sessionId: msg.payload.sessionId,
                    eventId: msg.payload.eventId,
                    decision: msg.payload.decision,
                    message: msg.payload.message ?? '',
                  },
                }));
              }
            }
          } catch (err) {
            console.error('WS message error (client):', err);
          }
        });

        socket.on('close', () => {
          const clients = clientClients.get(deviceId);
          if (clients) {
            clients.delete(client);
            if (clients.size === 0) clientClients.delete(deviceId);
          }
        });
      }
    });
  };
}
