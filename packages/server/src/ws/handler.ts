import type { FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
import type postgres from 'postgres';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  pcClients, clientClients, pairingClients,
  type WsClient, type PairingClient,
} from './connection-registry.js';
import { applyApprovalQuota } from '../services/quota.js';

/** Grace period timers: device socket close → delay session cleanup by 30s.
 *  If the device reconnects within that window, the timer is cancelled. */
const disconnectTimers = new Map<string, NodeJS.Timeout>();
const DISCONNECT_GRACE_MS = 10_000;

/** Max bytes a single unauthenticated WebSocket may buffer.
 *  P1-6: prevents a malicious client from exhausting server memory by
 *  sending large frames before auth completes. Close the socket
 *  with code 4002 if exceeded. */
const PENDING_MAX_BYTES = 1_048_576; // 1 MB

export function isPendingInteractiveEvent(eventType: string): boolean {
  return eventType === 'approval_required' || eventType === 'input_required';
}

export function wsHandler(sql: postgres.Sql) {
  return function (socket: WebSocket, req: FastifyRequest) {
    const url = new URL(req.url, 'http://localhost');
    const deviceId = url.searchParams.get('device_id');
    const deviceSecret = url.searchParams.get('device_secret');

    // Token precedence: Authorization: Bearer <token> > ?token= query.
    // Header is preferred because it keeps the token out of access logs and
    // referer headers. The query fallback is kept for compatibility with:
    //   - the WeChat mini program, whose wx.connectSocket predates
    //     subprotocol/header support (2.18.0 still cannot set headers);
    //   - older PC bridge clients during the migration window.
    // This dual-read path will be removed on 2026-08-01 — see
    // docs/REMEDIATION-2026-06-03.md (B2-4).
    const authHeader = req.headers['authorization'];
    let token: string | null = null;
    if (typeof authHeader === 'string' && authHeader.toLowerCase().startsWith('bearer ')) {
      token = authHeader.slice(7).trim();
    }
    if (!token) token = url.searchParams.get('token');

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
    let pendingBytes = 0;
    const pending: Buffer[] = [];
    const activationRequests = new Map<string, string>(); // clientRequestId → sessionId (idempotency)

    socket.on('message', (raw: Buffer) => {
      if (!authed) {
        pendingBytes += raw.length;
        if (pendingBytes > PENDING_MAX_BYTES) {
          // Drop the connection — pre-auth buffer overflow is a strong
          // signal of abuse. The pairing/registration handshake fits in
          // well under 1 KB; anything bigger is suspect.
          socket.close(4002, 'pending buffer overflow');
          return;
        }
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
          (socket as any).__isAlive = true; // acknowledge server WS-level heartbeat
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

    function handleApprovalResponse(msg: any) {
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

        const pc = pcClients.get(deviceId!);
        if (!pc || pc.socket.readyState !== pc.socket.OPEN) {
          socket.send(JSON.stringify({ type: 'error', code: 'BRIDGE_NOT_CONNECTED' }));
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
            const clientEventId = claimed.data?.clientEventId ?? null;
            pc.socket.send(JSON.stringify({
              type: 'approval_forward',
              payload: {
                sessionId: msg.payload.sessionId,
                eventId: msg.payload.eventId,
                decision: msg.payload.decision,
                message: msg.payload.message ?? '',
                clientEventId,
              },
            }));

            const mpList = clientClients.get(deviceId!);
            if (mpList) {
              for (const mp of mpList) {
                if (mp.socket.readyState === mp.socket.OPEN) {
                  mp.socket.send(JSON.stringify({
                    type: 'event_resolved',
                    payload: {
                      sessionId: msg.payload.sessionId,
                      eventId: msg.payload.eventId,
                      decision: msg.payload.decision,
                    },
                  }));
                }
              }
            }
          });
        });
      }).catch((err) => {
        console.error('approval error:', err);
        socket.send(JSON.stringify({ type: 'error', code: 'SERVER_ERROR' }));
      });
    }

    /** Shared helper: expire pending events, mark session finished, broadcast to all WS clients.
     *  Used by detach_session (mini program), deactivate_session (bridge), and disconnect cleanup.
     *  Returns { ok: true } on success, { ok: false, code } on failure.
     *  Skips broadcasting to `socket` (sender) to avoid duplicate events. */
    async function finishSession(
      sessionId: string,
      socket?: WebSocket,
    ): Promise<{ ok: true } | { ok: false; code: string }> {
      try {
        const [row] = await sql`
          SELECT id FROM sessions
          WHERE id = ${sessionId} AND device_id = ${deviceId} AND status = 'active'
          LIMIT 1
        `;
        if (!row) return { ok: false, code: 'SESSION_NOT_FOUND' };

        await sql.begin(async (tx) => {
          await tx`
            UPDATE events SET pending = false, decision = 'expired'
            WHERE session_id = ${sessionId} AND pending = true
          `;
          await tx`
            UPDATE sessions SET status = 'finished', finished_at = now()
            WHERE id = ${sessionId} AND status = 'active'
          `;
        });

        // Ack to sender
        if (socket && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'session_deactivated', payload: { sessionId } }));
        }

        // Broadcast to all mini program clients (skip sender)
        const mpList = clientClients.get(deviceId!);
        if (mpList) {
          for (const mp of mpList) {
            if (mp.socket !== socket && mp.socket.readyState === mp.socket.OPEN) {
              mp.socket.send(JSON.stringify({ type: 'session_deactivated', payload: { sessionId } }));
            }
          }
        }

        // Notify bridge sidebar (skip sender)
        const pc = pcClients.get(deviceId!);
        if (pc && pc.socket !== socket && pc.socket.readyState === pc.socket.OPEN) {
          pc.socket.send(JSON.stringify({ type: 'session_deactivated', payload: { sessionId } }));
        }

        return { ok: true };
      } catch (err) {
        console.error('finishSession error:', err);
        return { ok: false, code: 'DB_ERROR' };
      }
    }

    function handleDeviceMessage(msg: any) {
      if (msg.type === 'approval_response') {
        handleApprovalResponse(msg);
        return;
      }

      if (msg.type === 'register_session') {
        const claudeSessionId = msg.payload?.claudeSessionId ?? null;
        const clientRequestId = msg.payload?.clientRequestId ?? null;

        // Single transaction: check + reuse/insert, no race between SELECT and INSERT
        sql.begin(async (tx) => {
          // Build metadata once (shared between reuse and insert paths)
          const metadata: Record<string, string> = {};
          if (claudeSessionId) metadata.claudeSessionId = claudeSessionId;
          if (msg.payload.windowId) metadata.windowId = msg.payload.windowId;
          if (msg.payload.sessionLabel) metadata.title = msg.payload.sessionLabel;
          if (msg.payload.metadata && typeof msg.payload.metadata === 'object') {
            for (const [key, value] of Object.entries(msg.payload.metadata)) {
              if (typeof value === 'string' && value.trim()) metadata[key] = value;
            }
          }
          metadata.lastHookAt = new Date().toISOString();

          if (claudeSessionId) {
            // Reuse existing active session for this claudeSessionId
            const [existing] = await tx`
              SELECT id FROM sessions
              WHERE device_id = ${deviceId} AND status = 'active'
              AND metadata->>'claudeSessionId' = ${claudeSessionId}
              LIMIT 1
            `;
            if (existing) {
              // Merge — don't replace — so a re-registration that lacks a
              // sessionLabel does not wipe a title set by a previous call.
              await tx`
                UPDATE sessions SET metadata = metadata || ${tx.json(metadata)}, last_active_at = now()
                WHERE id = ${existing.id}
              `;
              return { sessionId: existing.id, isNew: false, source: metadata.source ?? null };
            }
          }

          // Legacy (no claudeSessionId): close ALL active sessions before creating new
          if (!claudeSessionId) {
            const oldSessions = await tx`
              SELECT id FROM sessions
              WHERE device_id = ${deviceId} AND status = 'active'
            `;
            for (const s of oldSessions) {
              await tx`
                UPDATE events SET pending = false, decision = 'expired'
                WHERE session_id = ${s.id} AND pending = true
              `;
            }
            await tx`
              UPDATE sessions SET status = 'finished', finished_at = now()
              WHERE device_id = ${deviceId} AND status = 'active'
            `;
          }

          // No existing session found — insert new
          const [newSession] = await tx`
            INSERT INTO sessions (device_id, agent_type, status, metadata)
            VALUES (${deviceId}, ${msg.payload.agentType ?? 'claude-code'}, 'active', ${tx.json(metadata)})
            RETURNING id
          `;
          return { sessionId: newSession.id, isNew: true, source: metadata.source ?? null };
        }).then(({ sessionId, source }) => {
          const pc = pcClients.get(deviceId!);
          if (pc && !pc.sessionId) {
            pc.sessionId = sessionId;
          }

          socket.send(JSON.stringify({
            type: 'session_registered',
            payload: { clientRequestId, sessionId, claudeSessionId },
          }));

          const visibleToMiniProgram = !!claudeSessionId;
          const mpList = visibleToMiniProgram ? clientClients.get(deviceId!) : undefined;
          if (mpList) {
            for (const mp of mpList) {
              if (mp.socket.readyState === mp.socket.OPEN) {
                mp.socket.send(JSON.stringify({
                  type: 'session_registered',
                  payload: { sessionId },
                }));
              }
            }
          }
        }).catch((err) => {
          console.error('register_session error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
        });
        return;
      }

      if (msg.type === 'activate_window') {
      const windowId = msg.payload?.windowId ?? null;
      const sessionLabel = msg.payload?.sessionLabel ?? null;
      const clientRequestId = msg.payload?.clientRequestId ?? null;
      if (!windowId) {
        socket.send(JSON.stringify({ type: 'error', code: 'INVALID_PAYLOAD' }));
        return;
      }

      // True idempotency: same clientRequestId → same session
      if (clientRequestId) {
        const existingSid = activationRequests.get(clientRequestId);
        if (existingSid) {
          socket.send(JSON.stringify({
            type: 'session_registered',
            payload: { clientRequestId, sessionId: existingSid, windowId },
          }));
          return;
        }
      }

      sql.begin(async (tx) => {
        const [oldSession] = await tx`
          SELECT id FROM sessions
          WHERE device_id = ${deviceId} AND status = 'active'
          AND metadata->>'windowId' = ${windowId}
          LIMIT 1
        `;
        if (oldSession) {
          await tx`
            UPDATE events SET pending = false, decision = 'expired'
            WHERE session_id = ${oldSession.id} AND pending = true
          `;
          await tx`
            UPDATE sessions SET status = 'finished', finished_at = now()
            WHERE id = ${oldSession.id}
          `;
        }

        const metadata: Record<string, string> = { windowId };
        if (sessionLabel) metadata.title = sessionLabel;
        if (msg.payload.source) metadata.source = msg.payload.source;
        const [newSession] = await tx`
          INSERT INTO sessions (device_id, agent_type, status, metadata)
          VALUES (${deviceId}, 'claude-code-hook', 'active', ${tx.json(metadata)})
          RETURNING id
        `;

        const pc = pcClients.get(deviceId!);
        if (pc) {
          if (!pc.sessionId || (oldSession && pc.sessionId === oldSession.id)) {
            pc.sessionId = newSession.id;
          }
        }

        if (clientRequestId) activationRequests.set(clientRequestId, newSession.id);
        return { newSession, oldSession };
      }).then(({ newSession, oldSession }) => {
        socket.send(JSON.stringify({
          type: 'session_registered',
          payload: { clientRequestId, sessionId: newSession.id, windowId },
        }));

        const visibleToMiniProgram = msg.payload.source === 'transcript_attach'
          || !!msg.payload.metadata?.claudeSessionId;
        const mpList = visibleToMiniProgram ? clientClients.get(deviceId!) : undefined;
        if (mpList) {
          for (const mp of mpList) {
            if (mp.socket.readyState === mp.socket.OPEN) {
              // Notify about old session being replaced
              if (oldSession) {
                mp.socket.send(JSON.stringify({
                  type: 'session_deactivated',
                  payload: { sessionId: oldSession.id },
                }));
              }
              mp.socket.send(JSON.stringify({
                type: 'session_registered',
                payload: { sessionId: newSession.id, windowId },
              }));
            }
          }
        }
      }).catch((err) => {
        console.error('activate_window error:', err);
        socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
      });
      return;
    }

      if (msg.type === 'attach_session') {
        const sessionId = msg.payload?.sessionId ?? null;
        const claudeSessionId = msg.payload?.claudeSessionId ?? null;
        if (!sessionId || !claudeSessionId) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_PAYLOAD' }));
          return;
        }

        const metadata: Record<string, string> = {
          claudeSessionId,
          runtime: 'claude-code',
          source: 'transcript_attach',
          attachedAt: new Date().toISOString(),
        };
        if (msg.payload.metadata && typeof msg.payload.metadata === 'object') {
          for (const [key, value] of Object.entries(msg.payload.metadata)) {
            if (typeof value === 'string' && value.trim()) metadata[key] = value;
          }
        }

        sql`
          UPDATE sessions
          SET metadata = metadata || ${sql.json(metadata)}, last_active_at = now()
          WHERE id = ${sessionId}
            AND device_id = ${deviceId}
            AND status = 'active'
            AND metadata->>'claudeSessionId' = ${claudeSessionId}
          RETURNING id
        `.then(([session]) => {
          if (!session) {
            socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_FOUND' }));
            return;
          }

          socket.send(JSON.stringify({
            type: 'session_registered',
            payload: { sessionId, claudeSessionId },
          }));

          const mpList = clientClients.get(deviceId!);
          if (mpList) {
            for (const mp of mpList) {
              if (mp.socket.readyState === mp.socket.OPEN) {
                mp.socket.send(JSON.stringify({
                  type: 'session_registered',
                  payload: { sessionId },
                }));
              }
            }
          }
        }).catch((err) => {
          console.error('attach_session error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
        });
        return;
      }

    if (msg.type === 'event') {
        if (!deviceId) return;
        const pc = pcClients.get(deviceId);
        if (!pc) {
          socket.send(JSON.stringify({ type: 'error', code: 'BRIDGE_NOT_CONNECTED' }));
          return;
        }

        const sessionId = msg.payload?.sessionId || pc.sessionId;
        if (!sessionId) {
          socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_REGISTERED' }));
          return;
        }

        // Validate session ownership + active status before insert
        sql`
          SELECT id, metadata FROM sessions
          WHERE id = ${sessionId} AND device_id = ${deviceId} AND status = 'active'
          LIMIT 1
        `.then((rows) => {
          if (rows.length === 0) {
            socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_FOUND' }));
            return;
          }

          const pending = isPendingInteractiveEvent(msg.payload.eventType);
          const eventData = msg.payload.data ? { ...msg.payload.data } : {};
          if (msg.payload.clientEventId) eventData.clientEventId = msg.payload.clientEventId;
          sql`
            INSERT INTO events (session_id, type, data, risk_level, pending)
            VALUES (${sessionId}, ${msg.payload.eventType},
                    ${sql.json(eventData)}, ${msg.payload.data?.risk ?? null}, ${pending})
            RETURNING id
          `.then(async ([event]) => {
            // Bump session activity timestamp (background, non-critical)
            sql`UPDATE sessions SET last_active_at = now() WHERE id = ${sessionId}`.catch(() => {});
            // If event carries windowId/label, persist in session metadata
            if (msg.payload.sessionLabel) {
              sql`UPDATE sessions SET metadata = metadata || ${sql.json({ title: msg.payload.sessionLabel })} WHERE id = ${sessionId}`.catch(() => {});
            }
            if (msg.payload.windowId) {
              sql`UPDATE sessions SET metadata = metadata || ${sql.json({ windowId: msg.payload.windowId })} WHERE id = ${sessionId}`.catch(() => {});
            }
            socket.send(JSON.stringify({
              type: 'event_ack',
              payload: {
                clientEventId: msg.payload.clientEventId ?? null,
                serverEventId: event.id,
              },
            }));

            const sessionMetadata = rows[0].metadata ?? {};
            const visibleToMiniProgram = sessionMetadata.source === 'transcript_attach'
              || sessionMetadata.runtime === 'opencode'
              || sessionMetadata.runtime === 'codex-resume'
              || !!sessionMetadata.claudeSessionId;
            const mpList = visibleToMiniProgram ? clientClients.get(deviceId!) : undefined;

            // Phase 3 quota gate: any event that pushes to the mini program
            // for user interaction counts against a free user's monthly
            // cap — approval_required AND input_required. Routing around
            // the cap via input_required would defeat the whole point of
            // the gate, so we use the same predicate that marks these
            // events as pending (see isPendingInteractiveEvent above).
            // trial / paid users are unlimited (the service short-circuits
            // on tier). The event is still written to `events` above for
            // audit, but when over the cap we skip the event_push and
            // tell the mini program why.
            if (mpList && isPendingInteractiveEvent(msg.payload.eventType)) {
              const outcome = await applyApprovalQuota(
                sql,
                deviceId!,
                msg.payload.clientEventId ?? null,
              );
              if (outcome.kind === 'over_limit') {
                // Phone: send quota_exceeded so the mini program can show
                // a toast explaining why no approval card appeared.
                for (const mp of mpList) {
                  if (mp.socket.readyState === mp.socket.OPEN) {
                    mp.socket.send(JSON.stringify({
                      type: 'quota_exceeded',
                      payload: {
                        sessionId,
                        eventId: event.id,
                        clientEventId: msg.payload.clientEventId ?? null,
                        product: 'codekey',
                        used: outcome.used,
                        limit: outcome.limit,
                        period: outcome.period,
                      },
                    }));
                  }
                }
                // PC bridge: send an immediate approval_forward with
                // decision 'deny' so the bridge resolves its pending
                // approval instead of blocking for 30 min (PENDING_TTL).
                // Also update the DB event so audit is accurate.
                sql`
                  UPDATE events SET pending = false, decision = 'deny',
                    responded_at = now() WHERE id = ${event.id} AND pending = true
                `.catch(() => {});
                pc.socket.send(JSON.stringify({
                  type: 'approval_forward',
                  payload: {
                    sessionId,
                    eventId: event.id,
                    decision: 'deny',
                    message: 'Free quota exhausted this month',
                    clientEventId: msg.payload.clientEventId ?? null,
                  },
                }));
                return;
              }
              // unlimited / allowed / fail_open → fall through to event_push.
            }

            if (mpList) {
              for (const mp of mpList) {
                if (mp.socket.readyState === mp.socket.OPEN) {
                  mp.socket.send(JSON.stringify({
                    type: 'event_push',
                    payload: {
                      sessionId,
                      eventId: event.id,
                      eventType: msg.payload.eventType,
                      summary: msg.payload.data.summary ?? msg.payload.data.command ?? '',
                      summaryShort: msg.payload.data.summaryShort ?? msg.payload.data.summary ?? '',
                      risk: msg.payload.data.risk,
                    },
                  }));
                }
              }
            }

            // task_complete is recorded as an event but does NOT close the session.
            // Session lifecycle is managed by activate_window / deactivate_session.
          }).catch((err) => {
            console.error('event insert error:', err);
            socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
          });
        }).catch(() => {
          socket.send(JSON.stringify({ type: 'error', code: 'SERVER_ERROR' }));
        });
        return;
      }

      if (msg.type === 'update_session_label') {
        const sessionId = msg.payload?.sessionId;
        const label = msg.payload?.label;
        if (!sessionId || !label) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_PAYLOAD' }));
          return;
        }
        sql`
          UPDATE sessions SET metadata = metadata || ${sql.json({ title: label })}
          WHERE id = ${sessionId} AND device_id = ${deviceId}
        `.then(() => {
          socket.send(JSON.stringify({
            type: 'session_label_updated',
            payload: { sessionId, label },
          }));

          // Broadcast to mini program clients so they refresh session name
          const mpList = clientClients.get(deviceId!);
          if (mpList) {
            for (const mp of mpList) {
              if (mp.socket.readyState === mp.socket.OPEN) {
                mp.socket.send(JSON.stringify({
                  type: 'session_label_updated',
                  payload: { sessionId, label },
                }));
              }
            }
          }
        }).catch((err) => {
          console.error('update_session_label error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
        });
        return;
      }

      if (msg.type === 'deactivate_session') {
        const sessionId = msg.payload?.sessionId ?? null;
        if (!sessionId) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_PAYLOAD' }));
          return;
        }

        finishSession(sessionId, socket).then((result) => {
          if (result.ok) {
            const pc = pcClients.get(deviceId!);
            if (pc && pc.sessionId === sessionId) {
              pc.sessionId = undefined;
            }
          } else {
            socket.send(JSON.stringify({ type: 'error', code: result.code }));
          }
        });
        return;
      }

      // Deactivate all sessions matching a windowId prefix (handles both window-level and tab-level)
      if (msg.type === 'deactivate_by_window') {
        const windowIdPrefix = msg.payload?.windowIdPrefix ?? null;
        if (!windowIdPrefix) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_PAYLOAD' }));
          return;
        }

        sql.begin(async (tx) => {
          const sessions: { id: string }[] = await tx`
            SELECT id FROM sessions
            WHERE device_id = ${deviceId} AND status = 'active'
            AND (metadata->>'windowId' = ${windowIdPrefix}
                 OR metadata->>'windowId' LIKE ${windowIdPrefix + '\\_%'})
          `;
          if (sessions.length === 0) return [] as { id: string }[];

          await tx`
            UPDATE events SET pending = false, decision = 'expired'
            WHERE session_id IN (SELECT id FROM sessions
              WHERE device_id = ${deviceId} AND status = 'active'
              AND (metadata->>'windowId' = ${windowIdPrefix}
                   OR metadata->>'windowId' LIKE ${windowIdPrefix + '\\_%'}))
            AND pending = true
          `;
          await tx`
            UPDATE sessions SET status = 'finished', finished_at = now()
            WHERE device_id = ${deviceId} AND status = 'active'
            AND (metadata->>'windowId' = ${windowIdPrefix}
                 OR metadata->>'windowId' LIKE ${windowIdPrefix + '\\_%'})
          `;
          return sessions;
        }).then((finishedSessions) => {
          const mpList = clientClients.get(deviceId!);
          if (mpList && finishedSessions.length > 0) {
            for (const mp of mpList) {
              if (mp.socket.readyState === mp.socket.OPEN) {
                for (const s of finishedSessions) {
                  mp.socket.send(JSON.stringify({
                    type: 'session_deactivated',
                    payload: { sessionId: s.id },
                  }));
                }
              }
            }
          }
          socket.send(JSON.stringify({ type: 'sessions_deactivated', count: finishedSessions.length }));
        }).catch((err) => {
          console.error('deactivate_by_window error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
        });
        return;
      }

      if (msg.type === 'resolve_event') {
        const eventId = msg.payload?.eventId;
        if (!eventId) return;
        // Try to find the event by id OR by clientEventId in the data field
        sql`
          UPDATE events SET pending = false, decision = 'resolved_by_bridge'
          WHERE pending = true AND (id = ${eventId} OR data->>'clientEventId' = ${eventId})
        `.then(() => {
          // Broadcast to mini program clients so they remove the stale approval
          const mpList = clientClients.get(deviceId!);
          if (mpList) {
            for (const mp of mpList) {
              if (mp.socket.readyState === mp.socket.OPEN) {
                mp.socket.send(JSON.stringify({
                  type: 'event_resolved',
                  payload: { eventId },
                }));
              }
            }
          }
        }).catch((err) => {
          console.error('resolve_event error:', err);
        });
        return;
      }

      if (msg.type === 'prune_sessions') {
        const keepClaudeSessionIds: string[] = msg.payload?.keepClaudeSessionIds ?? [];
        // Safety: never prune with an empty keep list — that would wipe all
        // transcript-attached sessions, which is probably a transient startup state.
        if (keepClaudeSessionIds.length === 0) {
          socket.send(JSON.stringify({ type: 'prune_done', payload: { deleted: 0 } }));
          return;
        }

        // Guard against non-UUID entries leaking in from a corrupted bridge state.
        // postgres.js would otherwise pass them as text and PG would emit
        // "column <uuid> does not exist" on the IN/= ANY comparison.
        const safeKeepIds = keepClaudeSessionIds.filter((s) =>
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s),
        );
        if (safeKeepIds.length === 0) {
          socket.send(JSON.stringify({ type: 'prune_done', payload: { deleted: 0 } }));
          return;
        }

        sql.begin(async (tx) => {
          // Keep only the latest session per claudeSessionId in the keep list.
          // All older finished transcript_attach sessions get deleted, even if
          // their claudeSessionId is still in the keep list — avoids accumulation
          // of duplicates from repeated push/detach cycles.
          const keepLatest: { id: string }[] = await tx`
            SELECT DISTINCT ON (metadata->>'claudeSessionId') id
            FROM sessions
            WHERE device_id = ${deviceId}
              AND metadata->>'source' = 'transcript_attach'
              AND metadata->>'claudeSessionId' = ANY(${sql.array(safeKeepIds)})
            ORDER BY metadata->>'claudeSessionId', started_at DESC
          `;
          const keepIds = keepLatest.map((r) => r.id);

          const toDelete: { id: string }[] = await tx`
            SELECT id FROM sessions
            WHERE device_id = ${deviceId}
              AND status = 'finished'
              AND metadata->>'source' = 'transcript_attach'
              AND id <> ALL(${sql.array(keepIds.length > 0 ? keepIds : ['00000000-0000-0000-0000-000000000000'])}::uuid[])
          `;
          if (toDelete.length === 0) return [];

          const ids = toDelete.map((r) => r.id);
          await tx`DELETE FROM approvals WHERE session_id = ANY(${sql.array(ids)}::uuid[])`;
          await tx`DELETE FROM events WHERE session_id = ANY(${sql.array(ids)}::uuid[])`;
          await tx`DELETE FROM sessions WHERE id = ANY(${sql.array(ids)}::uuid[])`;
          return ids;
        }).then((deletedIds) => {
          const count = Array.isArray(deletedIds) ? deletedIds.length : 0;
          socket.send(JSON.stringify({ type: 'prune_done', payload: { deleted: count } }));
        }).catch((err) => {
          console.error('prune_sessions error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'DB_ERROR' }));
        });
        return;
      }

      if (msg.type === 'query_attached_sessions') {
        sql`
          SELECT id, metadata FROM sessions
          WHERE device_id = ${deviceId} AND status = 'active'
          AND metadata->>'source' = 'transcript_attach'
          AND coalesce(metadata->>'claudeSessionId', '') <> ''
        `.then((rows: any) => {
          const sessions = rows.map((r: any) => ({
            id: r.id,
            claudeSessionId: r.metadata?.claudeSessionId ?? null,
          }));
          socket.send(JSON.stringify({ type: 'attached_sessions', payload: { sessions } }));
        }).catch((err) => {
          console.error('query_attached_sessions error:', err);
          socket.send(JSON.stringify({ type: 'error', code: 'SERVER_ERROR' }));
        });
        return;
      }
    }

    function handleClientMessage(msg: any) {
      if (msg.type === 'approval_response') {
        handleApprovalResponse(msg);
        return;
      }

      if (msg.type === 'command') {
        const { sessionId, action, data } = msg.payload ?? {};
        if (!sessionId || action !== 'write_stdin' || data === undefined) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_PAYLOAD' }));
          return;
        }

        sql`
          SELECT id, metadata FROM sessions
          WHERE id = ${sessionId} AND device_id = ${deviceId}
          LIMIT 1
        `.then((rows) => {
          if (rows.length === 0) {
            socket.send(JSON.stringify({ type: 'error', code: 'SESSION_NOT_FOUND' }));
            return;
          }

          const pc = pcClients.get(deviceId!);
          if (!pc || pc.socket.readyState !== pc.socket.OPEN) {
            socket.send(JSON.stringify({ type: 'error', code: 'BRIDGE_NOT_CONNECTED' }));
            return;
          }

          const claudeSessionId = (rows[0] as any).metadata?.claudeSessionId ?? null;
          pc.socket.send(JSON.stringify({
            type: 'command',
            payload: { sessionId, action, data, claudeSessionId },
          }));
        }).catch(() => {
          socket.send(JSON.stringify({ type: 'error', code: 'SERVER_ERROR' }));
        });
        return;
      }

      if (msg.type === 'detach_session') {
        const sessionId = msg.payload?.sessionId ?? null;
        if (!sessionId) {
          socket.send(JSON.stringify({ type: 'error', code: 'INVALID_PAYLOAD' }));
          return;
        }
        finishSession(sessionId, socket).then((result) => {
          if (!result.ok) {
            socket.send(JSON.stringify({ type: 'error', code: result.code }));
          }
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

      const tok = rows[0] as { token_type: string; label: string };
      tokenType = tok.token_type;
      authed = true;
      const clientLabel = tok.label || '';

      if (tok.token_type === 'device') {
        const client: WsClient = { socket, deviceId, tokenType: 'device' };
        pcClients.set(deviceId, client);

        // Notify mini program clients that the device (PC bridge) is back online
        const mpList = clientClients.get(deviceId);
        if (mpList) {
          for (const mp of mpList) {
            if (mp.socket.readyState === mp.socket.OPEN) {
              mp.socket.send(JSON.stringify({ type: 'device_online' }));
            }
          }
        }
        if (mpList && mpList.size > 0 && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'mp_online' }));
        }

        // Heartbeat ping/pong: set alive initially, reset on pong reply.
        // When VS Code closes abruptly, the bridge WebSocket won't close cleanly on
        // Windows. The server pings every 10s and terminates sockets that don't reply.
        (socket as any).__isAlive = true;
        socket.on('pong', () => { (socket as any).__isAlive = true; });

        // Cancel any pending disconnect cleanup (device reconnected within grace period)
        const pendingTimer = disconnectTimers.get(deviceId);
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          disconnectTimers.delete(deviceId);
        }

        socket.on('close', () => {
          // Stale socket: a newer connection already replaced this one.
          // Do NOT delete pcClients or schedule cleanup — the new socket owns the sessions.
          const current = pcClients.get(deviceId);
          if (current?.socket !== socket) return;

          pcClients.delete(deviceId);

          // Notify mini program clients that the device (PC bridge) went offline
          const mpList = clientClients.get(deviceId);
          if (mpList) {
            for (const mp of mpList) {
              if (mp.socket.readyState === mp.socket.OPEN) {
                mp.socket.send(JSON.stringify({ type: 'device_offline' }));
              }
            }
          }

          // Delay session cleanup by DISCONNECT_GRACE_MS to tolerate brief reconnections.
          // The close handler above already guards against a newer socket
          // replacing this one; the timer callback does a second check in
          // case a new connection came up in the grace window.
          const timer = setTimeout(() => {
            disconnectTimers.delete(deviceId);
            if (pcClients.get(deviceId)) {
              // Device reconnected in the grace window; leave sessions alone.
              return;
            }
            sql`
              SELECT id FROM sessions
              WHERE device_id = ${deviceId} AND status = 'active'
            `.then((rows: any) => {
              const activeSessions = rows as { id: string }[];
              for (const s of activeSessions) {
                finishSession(s.id);
              }
            }).catch((err) => {
              console.error('device disconnect cleanup error:', err);
            });
          }, DISCONNECT_GRACE_MS);

          disconnectTimers.set(deviceId, timer);
        });
      } else if (tok.token_type === 'client') {
        const client: WsClient = { socket, deviceId, tokenType: 'client' };
        if (!clientClients.has(deviceId)) {
          clientClients.set(deviceId, new Set());
        }
        clientClients.get(deviceId)!.add(client);
        const bridge = pcClients.get(deviceId);
        const platform = clientLabel.includes('feishu') ? 'feishu' : 'wechat';
        if (bridge && bridge.socket.readyState === bridge.socket.OPEN) {
          bridge.socket.send(JSON.stringify({ type: 'mp_online', platform }));
        }
        socket.on('close', () => {
          const clients = clientClients.get(deviceId);
          if (clients) {
            clients.delete(client);
            if (clients.size === 0) {
            clientClients.delete(deviceId);
            const bridge = pcClients.get(deviceId);
            if (bridge && bridge.socket.readyState === bridge.socket.OPEN) {
              bridge.socket.send(JSON.stringify({ type: 'mp_offline', platform }));
            }
          }
          }
        });
      }

      // Drain buffered messages
      for (const buf of pending) dispatch(buf);
    });
  };
}
