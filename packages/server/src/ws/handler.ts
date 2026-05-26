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

    // Buffer for messages received before auth check completes.
    // The message handler MUST be registered synchronously, otherwise a
    // client that sends messages immediately after connect() can race
    // ahead of the async auth SQL query and lose messages.
    let authed = false;
    let tokenType: string | null = null;
    const pending: Buffer[] = [];

    socket.on('message', (raw: Buffer) => {
      if (!authed) {
        pending.push(raw);
        return;
      }
      dispatch(raw);
    });

    function dispatch(raw: Buffer) {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'ping') {
          socket.send(JSON.stringify({ type: 'pong', ts: new Date().toISOString() }));
          return;
        }

        if (tokenType === 'device') {
          handleDeviceMessage(msg);
        } else if (tokenType === 'client') {
          handleClientMessage(msg);
        }
        // pairing mode doesn't process messages beyond ping
      } catch (err) {
        console.error('WS message error:', err);
      }
    }

    function handleDeviceMessage(msg: any) {
      if (msg.type === 'register_session') {
        sql`
          INSERT INTO sessions (device_id, agent_type, status, metadata)
          VALUES (${deviceId}, ${msg.payload.agentType ?? 'claude-code'}, 'active', '{}')
          RETURNING id
        `.then(([sessionRecord]) => {
          const pc = pcClients.get(deviceId!);
          if (pc) pc.sessionId = sessionRecord.id;
          socket.send(JSON.stringify({
            type: 'session_registered',
            payload: { sessionId: sessionRecord.id },
          }));
        }).catch((err) => {
          console.error('register_session error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
        });
        return;
      }

      if (msg.type === 'event') {
        if (!deviceId) return;
        const pc = pcClients.get(deviceId);
        if (!pc || !pc.sessionId) {
          socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_REGISTERED' }));
          return;
        }

        sql`
          INSERT INTO events (session_id, type, data, risk_level, pending)
          VALUES (${pc.sessionId}, ${msg.payload.eventType},
                  ${msg.payload.data}, ${msg.payload.data.risk ?? null}, true)
          RETURNING id
        `.then(([event]) => {
          socket.send(JSON.stringify({
            type: 'event_ack',
            payload: {
              clientEventId: msg.payload.clientEventId ?? null,
              serverEventId: event.id,
            },
          }));

          const mpList = clientClients.get(deviceId!);
          if (mpList) {
            for (const mp of mpList) {
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
        }).catch((err) => {
          console.error('event insert error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
        });
        return;
      }
    }

    function handleClientMessage(msg: any) {
      if (msg.type === 'approval_response') {
        sql`
          SELECT e.*, s.device_id AS session_device_id
          FROM events e
          JOIN sessions s ON e.session_id = s.id
          WHERE e.id = ${msg.payload.eventId}
        `.then(([eventRec]: any[]) => {
          if (!eventRec) {
            socket.send(JSON.stringify({ type: 'error', code: 'EVENT_NOT_FOUND' }));
            return;
          }
          if (!eventRec.pending) {
            socket.send(JSON.stringify({ type: 'error', code: 'ALREADY_RESPONDED' }));
            return;
          }

          if (eventRec.session_device_id !== deviceId) {
            socket.send(JSON.stringify({ type: 'error', code: 'ACCESS_DENIED' }));
            return;
          }

          const ALLOWED_DECISIONS: Record<string, string[]> = {
            low: ['approve', 'deny', 'pause', 'reply'],
            medium: ['approve', 'deny', 'pause', 'reply'],
            high: ['deny', 'pause', 'reply'],
            critical: ['deny', 'pause'],
            unknown: ['deny', 'pause', 'reply'],
          };
          const allowed = (ALLOWED_DECISIONS[eventRec.risk_level as string] ?? ['deny', 'pause']);
          if (!allowed.includes(msg.payload.decision)) {
            socket.send(JSON.stringify({ type: 'error', code: 'RISK_TOO_HIGH' }));
            return;
          }

          sql`
            UPDATE events SET pending = false, decision = ${msg.payload.decision},
              responded_at = now() WHERE id = ${msg.payload.eventId} AND pending = true
            RETURNING *
          `.then(([claimed]: any[]) => {
            if (!claimed) {
              socket.send(JSON.stringify({ type: 'error', code: 'ALREADY_RESPONDED' }));
              return;
            }

            sql`
              INSERT INTO approvals (event_id, session_id, decision, command, risk_level, message)
              VALUES (${claimed.id}, ${claimed.session_id}, ${msg.payload.decision},
                      ${claimed.data?.command ?? null}, ${claimed.risk_level},
                      ${msg.payload.message ?? null})
            `.then(() => {
              const pc = pcClients.get(deviceId!);
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
            });
          });
        }).catch((err) => {
          console.error('approval error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'SERVER_ERROR' }));
        });
        return;
      }
    }

    // ── Auth: device_secret (pairing flow) OR device_token (runtime) ──

    if (deviceSecret) {
      const secretHash = createHash('sha256').update(deviceSecret).digest('hex');
      sql`SELECT id FROM devices WHERE id = ${deviceId} AND device_secret = ${secretHash}`
        .then((rows) => {
          if (rows.length === 0) {
            socket.close(4001, 'invalid device_secret');
            return;
          }
          tokenType = 'pairing';
          authed = true;
          pairingClients.set(deviceId, { socket, deviceId });
          socket.on('close', () => {
            pairingClients.delete(deviceId);
          });
          socket.send(JSON.stringify({ type: 'pairing_ready', deviceId }));
          for (const buf of pending) dispatch(buf);
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
      tokenType = tok.token_type;
      authed = true;

      if (tok.token_type === 'device') {
        const client: WsClient = { socket, deviceId, tokenType: 'device' };
        pcClients.set(deviceId, client);
        socket.on('close', () => pcClients.delete(deviceId));
      } else if (tok.token_type === 'client') {
        const client: WsClient = { socket, deviceId, tokenType: 'client' };
        if (!clientClients.has(deviceId)) {
          clientClients.set(deviceId, new Set());
        }
        clientClients.get(deviceId)!.add(client);
        socket.on('close', () => {
          const clients = clientClients.get(deviceId);
          if (clients) {
            clients.delete(client);
            if (clients.size === 0) clientClients.delete(deviceId);
          }
        });
      }

      // Drain buffered messages
      for (const buf of pending) dispatch(buf);
    });
  };
}
