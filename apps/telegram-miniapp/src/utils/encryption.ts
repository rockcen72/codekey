/**
 * encryption.ts — AES-256-GCM symmetric encryption for Telegram mini app.
 *
 * Uses Web Crypto API (crypto.subtle), which is natively available in
 * Telegram Mini App's WebView environment. Zero additional dependencies.
 *
 * Wire format must match packages/shared/src/bridge/encryption.ts EXACTLY:
 *   sealed_payload = base64(iv[12] ++ ciphertext ++ tag[16])
 *
 * AAD format (identical across platforms):
 *   utf8(JSON.stringify({ v, keyId, deviceId, sessionId, eventId, eventType }))
 */

// ── Constants (must match Node side) ───────────────────────

const ALGORITHM = 'AES-GCM' as const;
const KEY_LENGTH = 32;   // bytes (256 bits)
const IV_LENGTH = 12;    // bytes (96 bits, GCM recommended)
const TAG_LENGTH = 16;   // bytes (128 bits)

// ── Key utilities ──────────────────────────────────────────

export function generateContentKey(): { keyHex: string; keyId: string } {
  const key = new Uint8Array(KEY_LENGTH);
  crypto.getRandomValues(key);
  return {
    keyHex: buf2hex(key),
    keyId: crypto.randomUUID(),
  };
}

export function keyFromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Invalid key hex: expected 64 hex chars (0-9, a-f, A-F)');
  }
  return hex2buf(hex);
}

// ── AAD ────────────────────────────────────────────────────

export interface AadFields {
  v: number;
  keyId: string;
  deviceId: string;
  sessionId: string;
  eventId: string;
  eventType: string;
}

export function buildAad(fields: AadFields): Uint8Array {
  const json = JSON.stringify({
    v: fields.v,
    keyId: fields.keyId,
    deviceId: fields.deviceId,
    sessionId: fields.sessionId,
    eventId: fields.eventId,
    eventType: fields.eventType,
  });
  return new TextEncoder().encode(json);
}

// ── Type helper (TS 5.7 strict ArrayBuffer typing workaround) ──

function asBuf(v: Uint8Array): Uint8Array<ArrayBuffer> {
  // Reconstruct with explicit ArrayBuffer to satisfy TS strict typing
  return new Uint8Array(v.buffer.slice(0) as ArrayBuffer);
}

// ── Encrypt / Decrypt (async — Web Crypto API) ─────────────

export async function encrypt(
  plaintext: string,
  keyHex: string,
  aad: Uint8Array,
): Promise<string> {
  const key = await importKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const plaintextBytes = new TextEncoder().encode(plaintext);

  // Web Crypto API concatenates ciphertext + tag automatically
  const encrypted = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv: asBuf(iv), additionalData: asBuf(aad), tagLength: TAG_LENGTH * 8 },
    key,
    plaintextBytes,
  );

  // sealed_payload = iv + ciphertext + tag
  const combined = new Uint8Array(IV_LENGTH + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), IV_LENGTH);
  return buf2b64(combined);
}

export async function decrypt(
  sealedPayloadB64: string,
  keyHex: string,
  aad: Uint8Array,
): Promise<string> {
  const key = await importKey(keyHex);
  const combined = b642buf(sealedPayloadB64);

  if (combined.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('sealed_payload too short');
  }

  const iv = new Uint8Array(combined.buffer, 0, IV_LENGTH);
  // Web Crypto API expects ciphertext+tag as a single buffer
  const encrypted = new Uint8Array(combined.buffer, IV_LENGTH);

  const decrypted = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv: asBuf(iv), additionalData: asBuf(aad), tagLength: TAG_LENGTH * 8 },
    key,
    asBuf(encrypted),
  );
  return new TextDecoder().decode(decrypted);
}

// ── Internal helpers ───────────────────────────────────────

async function importKey(keyHex: string): Promise<CryptoKey> {
  const raw = hex2buf(keyHex);
  return crypto.subtle.importKey(
    'raw',
    asBuf(raw),
    { name: ALGORITHM, length: KEY_LENGTH * 8 },
    false, // not extractable
    ['encrypt', 'decrypt'],
  );
}

function hex2buf(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function buf2hex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function buf2b64(buf: Uint8Array): string {
  // Use browser-native btoa with a binary string
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]);
  }
  return btoa(binary);
}

function b642buf(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
