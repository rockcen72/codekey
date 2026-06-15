import { buildAad, encrypt, decrypt, keyFromHex } from './encryption.js';
import type { AadFields } from './encryption.js';
export type { AadFields } from './encryption.js';

/**
 * Allowlist keys — these remain in `data` as plaintext when `sealed_payload`
 * is present. All other keys are encrypted into `sealed_payload`.
 *
 * This set is the source of truth for Phase 3A+. NEVER add a key here
 * without cross-team review — adding a new allowlist key means the server
 * can now see that field for every new encrypted event.
 */
const ALLOWLIST_KEYS = new Set<string>([
  'type',
  'encrypted',
  'safe_summary',
  'preview_label',
]);

/**
 * Strip sensitive fields from `data`, returning the allowlist-only sanitized
 * data and the sensitive payload (everything else) as a JSON string.
 *
 * The sensitive payload is what gets encrypted into `sealed_payload`.
 */
export function stripSensitiveFields(data: Record<string, unknown>): {
  allowlistData: Record<string, unknown>;
  sensitivePayload: string;
} {
  const allowlistData: Record<string, unknown> = {};
  const sensitiveFields: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(data)) {
    if (ALLOWLIST_KEYS.has(key)) {
      allowlistData[key] = value;
    } else {
      sensitiveFields[key] = value;
    }
  }

  allowlistData.encrypted = true;

  return {
    allowlistData,
    sensitivePayload: JSON.stringify(sensitiveFields),
  };
}

/**
 * Build AAD for an event envelope. Calls through to the canonical
 * `buildAad()` in encryption.ts — this wrapper exists so callers
 * don't need to import from both modules.
 */
export function buildEventAad(fields: AadFields): Buffer {
  return buildAad(fields);
}

/**
 * Encrypt sensitive event fields into a sealed_payload envelope.
 *
 * Returns a partial event object that should be merged into the outbound
 * relay message:
 *   - `data` contains only allowlist fields (type + encrypted)
 *   - `sealed_payload` is the encrypted sensitive payload
 *   - `key_id` for key lookup on the phone
 *   - `encryption_version` = 1
 *
 * The caller is responsible for providing `safe_summary` and/or
 * `preview_label` in `data` before pushing to relay, if desired.
 */
export function encryptEventPayload(
  data: Record<string, unknown>,
  contentKeyHex: string,
  keyId: string,
  deviceId: string,
  sessionId: string,
  clientEventId: string,
  eventType: string,
): {
  data: Record<string, unknown>;
  sealed_payload: string;
  key_id: string;
  encryption_version: number;
} {
  const { allowlistData, sensitivePayload } = stripSensitiveFields(data);
  const key = keyFromHex(contentKeyHex);
  // eventId in the AAD is the clientEventId, NOT the server-generated event id
  const aad = buildAad({
    v: 1,
    keyId,
    deviceId,
    sessionId,
    eventId: clientEventId,
    eventType,
  });
  const sealedPayload = encrypt(sensitivePayload, key, aad);

  return {
    data: allowlistData,
    sealed_payload: sealedPayload,
    key_id: keyId,
    encryption_version: 1,
  };
}

/**
 * Decrypt a sealed_payload and merge the decrypted fields back into the
 * allowlist data, returning the complete original data object.
 *
 * Parameters come from the relay API response:
 *   - `sealedPayloadB64` → the `sealed_payload` field from the API
 *   - `allowlistData` → the `data` field from the API (allowlist only)
 *   - `contentKeyHex` → the 32-byte AES-256 key as hex
 *   - `aadFields` → the AAD fields used to encrypt (typically from the event metadata)
 *
 * Callers MUST validate `encrypted_version` before calling this.
 */
export function decryptEventPayload(
  sealedPayloadB64: string,
  allowlistData: Record<string, unknown>,
  contentKeyHex: string,
  aadFields: AadFields,
): Record<string, unknown> {
  const key = keyFromHex(contentKeyHex);
  const aad = buildAad(aadFields);
  const decryptedJson = decrypt(sealedPayloadB64, key, aad);
  const decrypted = JSON.parse(decryptedJson) as Record<string, unknown>;

  // Strip envelope markers — once decryption succeeds the data is plaintext;
  // leaving `encrypted: true` confuses downstream UI logic that uses it as
  // an "encryption failed" placeholder trigger.
  const { encrypted: _e, preview_label: _p, safe_summary: _s, encryption_error: _err, ...allowlistRest } = allowlistData;
  void _e; void _p; void _s; void _err;
  return { ...allowlistRest, ...decrypted };
}
