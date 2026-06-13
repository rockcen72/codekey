/**
 * encryption.ts — AES-256-GCM symmetric encryption for E2E event payloads.
 *
 * Used by: PC bridge (Node.js), Telegram mini app (Web Crypto API), WeChat mini app (@noble/ciphers).
 *
 * IMPORTANT: This is the canonical Node.js implementation. The Telegram and WeChat
 * implementations MUST produce identical sealed_payload bytes for the same inputs.
 *
 * Wire format:
 *   sealed_payload = base64(iv[12] ++ ciphertext ++ tag[16])
 *   key            = 32 random bytes (AES-256)
 *   iv             = 12 random bytes (GCM recommended)
 *   tag            = 16 bytes (GCM auth tag, appended by Node crypto)
 *
 * AAD (canonical JSON):
 *   utf8(JSON.stringify({ v, keyId, deviceId, sessionId, eventId, eventType }))
 *
 * Cross-platform invariants (DO NOT BREAK):
 *   1. JSON.stringify produces the same bytes on all platforms (sorted keys NOT needed
 *      because we control the field order in the object literal).
 *   2. AES-256-GCM with 96-bit IV and 128-bit tag.
 *   3. sealed_payload is always base64(iv + ciphertext + tag).
 */

import crypto from 'node:crypto';

// ── Constants ──────────────────────────────────────────────

export const ALGORITHM = 'aes-256-gcm' as const;
export const KEY_LENGTH = 32;   // bytes
export const IV_LENGTH = 12;    // bytes
export const TAG_LENGTH = 16;   // bytes

// ── Key generation ─────────────────────────────────────────

export interface KeyPair {
  key: Buffer;
  keyHex: string;
  keyId: string;
}

export function generateContentKey(): KeyPair {
  const key = crypto.randomBytes(KEY_LENGTH);
  return {
    key,
    keyHex: key.toString('hex'),
    keyId: crypto.randomUUID(),
  };
}

export function keyFromHex(hex: string): Buffer {
  const buf = Buffer.from(hex, 'hex');
  if (buf.length !== KEY_LENGTH) {
    throw new Error(`Invalid key length: expected ${KEY_LENGTH} bytes, got ${buf.length}`);
  }
  return buf;
}

// ── AAD ────────────────────────────────────────────────────

export interface AadFields {
  v: number;            // encryption_version, currently 1
  keyId: string;        // UUID
  deviceId: string;
  sessionId: string;
  eventId: string;      // clientEventId (NOT server-generated event id)
  eventType: string;
}

export function buildAad(fields: AadFields): Buffer {
  // Key order is intentional — matches the object literal below.
  // JSON.stringify on an object literal with explicit keys is deterministic
  // across JS engines (ES2020+), so we don't need sorted keys.
  const json = JSON.stringify({
    v: fields.v,
    keyId: fields.keyId,
    deviceId: fields.deviceId,
    sessionId: fields.sessionId,
    eventId: fields.eventId,
    eventType: fields.eventType,
  });
  return Buffer.from(json, 'utf8');
}

// ── Encrypt / Decrypt ──────────────────────────────────────

export function encrypt(
  plaintext: string,
  key: Buffer,
  aad: Buffer,
): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  if (aad.length > 0) {
    cipher.setAAD(aad, { plaintextLength: Buffer.byteLength(plaintext, 'utf8') });
  }
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const combined = Buffer.concat([iv, encrypted, tag]);
  return combined.toString('base64');
}

export function decrypt(
  sealedPayloadB64: string,
  key: Buffer,
  aad: Buffer,
): string {
  const combined = Buffer.from(sealedPayloadB64, 'base64');
  if (combined.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('sealed_payload too short');
  }
  const iv = combined.subarray(0, IV_LENGTH);
  const tag = combined.subarray(combined.length - TAG_LENGTH);
  const encrypted = combined.subarray(IV_LENGTH, combined.length - TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  if (aad.length > 0) {
    decipher.setAAD(aad, { plaintextLength: encrypted.length });
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}
