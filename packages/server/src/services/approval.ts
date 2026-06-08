import type postgres from 'postgres';
import { pcClients, clientClients } from '../ws/connection-registry.js';

/**
 * Shared approval validation and application logic.
 * Used by both WS handleApprovalResponse and HTTP POST /events/:id/approval-response.
 *
 * Returns { ok: true } on success, { ok: false, code, status? } on failure.
 */
export async function validateAndApplyApproval(
  sql: postgres.Sql,
  params: {
    eventId: string;
    decision: string;
    message?: string;
    userId?: number;       // for user-token auth (HTTP)
    deviceId?: string;     // for device-token auth (WS)
  },
): Promise<{ ok: true } | { ok: false; code: string; status?: number }> {
  const { eventId, decision, message, userId, deviceId } = params;

  // 1. Fetch event + session + device
  const [eventRec] = await sql`
    SELECT e.*, s.device_id AS session_device_id
    FROM events e
    JOIN sessions s ON e.session_id = s.id
    WHERE e.id = ${eventId}
  `;
  if (!eventRec) return { ok: false, code: 'EVENT_NOT_FOUND', status: 404 };
  if (!eventRec.pending) return { ok: false, code: 'ALREADY_RESPONDED', status: 409 };

  // 2. Ownership check
  if (userId !== undefined) {
    // User-token auth: verify device belongs to this user
    const [binding] = await sql`
      SELECT 1 FROM device_bindings
      WHERE device_id = ${eventRec.session_device_id}
        AND user_id = ${userId}
        AND unbound_at IS NULL
    `;
    if (!binding) return { ok: false, code: 'ACCESS_DENIED', status: 403 };
  } else if (deviceId !== undefined) {
    // Device-token auth: verify event belongs to this device
    if (eventRec.session_device_id !== deviceId) {
      return { ok: false, code: 'ACCESS_DENIED', status: 403 };
    }
  }

  // 3. Risk-level validation (same ALLOWED_DECISIONS as WS handler)
  const ALLOWED_DECISIONS: Record<string, string[]> = {
    low: ['approve', 'deny', 'pause', 'reply'],
    medium: ['approve', 'deny', 'pause', 'reply'],
    high: ['deny', 'pause', 'reply'],
    critical: ['deny', 'pause'],
    unknown: ['deny', 'pause', 'reply'],
  };
  const allowed = ALLOWED_DECISIONS[eventRec.risk_level as string] ?? ['deny', 'pause'];
  if (!allowed.includes(decision)) {
    return { ok: false, code: 'RISK_TOO_HIGH', status: 403 };
  }

  // 4. Check PC bridge is connected
  const resolvedDeviceId = eventRec.session_device_id as string;
  const pc = pcClients.get(resolvedDeviceId);
  if (!pc || pc.socket.readyState !== pc.socket.OPEN) {
    return { ok: false, code: 'BRIDGE_NOT_CONNECTED', status: 503 };
  }

  // 5. Atomic claim: update event (CAS on pending)
  const [claimed] = await sql`
    UPDATE events SET pending = false, decision = ${decision},
      responded_at = now() WHERE id = ${eventId} AND pending = true
    RETURNING *
  `;
  if (!claimed) return { ok: false, code: 'ALREADY_RESPONDED', status: 409 };

  // 6. Insert approval record
  await sql`
    INSERT INTO approvals (event_id, session_id, decision, command, risk_level, message)
    VALUES (${claimed.id}, ${claimed.session_id}, ${decision},
            ${claimed.data?.command ?? null}, ${claimed.risk_level},
            ${message ?? null})
  `;

  // 7. Forward to PC bridge
  const clientEventId = claimed.data?.clientEventId ?? null;
  pc.socket.send(JSON.stringify({
    type: 'approval_forward',
    payload: {
      sessionId: claimed.session_id,
      eventId,
      decision,
      message: message ?? '',
      clientEventId,
    },
  }));

  // 8. Notify all mini program clients for this device
  const mpList = clientClients.get(resolvedDeviceId);
  if (mpList) {
    for (const mp of mpList) {
      if (mp.socket.readyState === mp.socket.OPEN) {
        mp.socket.send(JSON.stringify({
          type: 'event_resolved',
          payload: {
            sessionId: claimed.session_id,
            eventId,
            decision,
          },
        }));
      }
    }
  }

  return { ok: true };
}
