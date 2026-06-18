import { buildAad, encrypt, decrypt, keyFromHex } from './encryption.js';
import type { AadFields } from './encryption.js';
export type { AadFields } from './encryption.js';

/**
 * Unified helper to resolve a command payload to its plaintext.
 *
 * If the payload contains a `sealed_command`, decrypts it using the provided
 * contentKeyHex/deviceId.  Otherwise returns `payload.data` as-is.
 *
 * Returns null when:
 *   - sealed_command is present but contentKeyHex or deviceId is missing
 *   - sealed_command is present but required fields (command_id, key_id) are missing
 *   - decryption throws (wrong key, tampered payload, AAD mismatch)
 *
 * Every consumer of relay 'command' events should call this first:
 *   CodexResumeManager, CodexRelay, ApprovalBridge.listenRelayCommands
 */
export function normalizeCommandPayload(
  payload: {
    data?: string;
    sealed_command?: string;
    command_id?: string;
    key_id?: string;
    encryption_version?: number;
    sessionId?: string;
  },
  contentKeyHex: string | undefined,
  deviceId: string | undefined,
): string | null {
  if (!payload.sealed_command) {
    return payload.data ?? null;
  }
  if (!contentKeyHex || !deviceId) {
    return null;
  }
  if (!payload.command_id || !payload.key_id) {
    return null;
  }
  const sessionId = payload.sessionId;
  if (!sessionId) return null;

  try {
    return decryptCommandPayload(
      payload.sealed_command,
      contentKeyHex,
      {
        v: payload.encryption_version ?? 1,
        keyId: payload.key_id,
        deviceId,
        sessionId,
        commandId: payload.command_id,
      },
    );
  } catch {
    return null;
  }
}

/**
 * Envelope keys that are always allowed in plaintext alongside a sealed_command.
 * Unlike event envelopes (which carry allowlist data for server-side push
 * notifications), sealed_command has zero metadata — the server just forwards
 * the opaque blob. These keys are nonetheless reserved for future use if
 * negotiation metadata (e.g. compression, algorithm negotiation) is needed.
 */
const ALLOWLIST_KEYS = new Set<string>(['command_id', 'key_id', 'encryption_version']);

/**
 * AAD discriminator value — ensures command envelope AAD can never collide
 * with event envelope AAD (which uses eventType like 'user_prompt').
 */
const COMMAND_EVENT_TYPE = 'command';

/**
 * Build AAD for a command envelope.
 *   kind: 'command'   ← discriminator from event envelopes
 *   commandId: UUID   ← client-generated, analogous to event's clientEventId
 *
 * Maps to existing AadFields: commandId → eventId, kind → eventType.
 * This reuses buildAad() without new crypto primitives.
 */
export function buildCommandAad(fields: {
  v: number;
  keyId: string;
  deviceId: string;
  sessionId: string;
  commandId: string;
}): Buffer {
  return buildAad({
    v: fields.v,
    keyId: fields.keyId,
    deviceId: fields.deviceId,
    sessionId: fields.sessionId,
    eventId: fields.commandId,
    eventType: COMMAND_EVENT_TYPE,
  });
}

/**
 * Encrypt a command text into a sealed_command envelope.
 *
 * The entire command text is encrypted — no plaintext metadata is leaked
 * to the relay server. The resulting envelope is opaque to the server:
 * it simply forwards { sealed_command, command_id, key_id, encryption_version }
 * to the PC bridge.
 */
export function encryptCommandPayload(
  text: string,
  contentKeyHex: string,
  keyId: string,
  deviceId: string,
  sessionId: string,
  commandId: string,
): {
  sealed_command: string;
  command_id: string;
  key_id: string;
  encryption_version: number;
} {
  const key = keyFromHex(contentKeyHex);
  const aad = buildCommandAad({
    v: 1,
    keyId,
    deviceId,
    sessionId,
    commandId,
  });
  const sealed = encrypt(text, key, aad);

  return {
    sealed_command: sealed,
    command_id: commandId,
    key_id: keyId,
    encryption_version: 1,
  };
}

/**
 * Decrypt a sealed_command and return the original command text.
 *
 * Parameters:
 *   - `sealedCommandB64` → the `sealed_command` field from the relay API
 *   - `contentKeyHex` → the 32-byte AES-256 key as hex
 *   - `aadFields` → the AAD fields used to encrypt
 *
 * Throws on GCM auth failure (tampered payload, wrong key, AAD mismatch).
 */
export function decryptCommandPayload(
  sealedCommandB64: string,
  contentKeyHex: string,
  aadFields: {
    v: number;
    keyId: string;
    deviceId: string;
    sessionId: string;
    commandId: string;
  },
): string {
  const key = keyFromHex(contentKeyHex);
  const aad = buildCommandAad(aadFields);
  return decrypt(sealedCommandB64, key, aad);
}
