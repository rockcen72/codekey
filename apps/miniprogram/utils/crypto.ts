/**
 * crypto.ts — AES-256-GCM symmetric encryption for WeChat mini program.
 *
 * Uses @noble/ciphers (pure JS, ~5KB gzip), loaded from vendor/ copies
 * because WeChat's npm build only outputs the main index.js (which throws).
 *
 * Wire format must match packages/shared/src/bridge/encryption.ts EXACTLY:
 *   sealed_payload = base64(iv[12] ++ ciphertext ++ tag[16])
 *
 * AAD format (identical across platforms):
 *   utf8(JSON.stringify({ v, keyId, deviceId, sessionId, eventId, eventType }))
 *
 * NOTE: WeChat mini program runtime lacks TextEncoder/TextDecoder.
 * This module installs them globally on first load so @noble/ciphers/utils
 * can use them internally. The polyfill is UTF-8 only (~1KB).
 */

// ── Polyfill TextEncoder/TextDecoder (UTF-8 only) ─────────
if (typeof TextEncoder === 'undefined') {
  (globalThis as any).TextEncoder = class {
    encode(str: string): Uint8Array {
      const escaped = unescape(encodeURIComponent(str));
      const len = escaped.length;
      const arr = new Uint8Array(len);
      for (let i = 0; i < len; i++) arr[i] = escaped.charCodeAt(i);
      return arr;
    }
  };
}
if (typeof TextDecoder === 'undefined') {
  (globalThis as any).TextDecoder = class {
    decode(buf: ArrayBuffer | Uint8Array): string {
      const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
      try {
        return decodeURIComponent(escape(String.fromCharCode(...bytes)));
      } catch {
        // Not valid UTF-8; return raw Latin-1 string for error messages.
        return String.fromCharCode(...bytes);
      }
    }
  };
}

// Load @noble/ciphers submodules from vendor/ (bypasses npm build limitation)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const gcmImpl: typeof import('@noble/ciphers/aes').gcm = require('../vendor/aes.js').gcm;
// utf8ToBytes/bytesToUtf8 from @noble/ciphers/utils; after our global polyfill
// they will use the TextEncoder/TextDecoder we installed above.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const nobleUtils = require('../vendor/utils.js');
const utf8ToBytes: (s: string) => Uint8Array = nobleUtils.utf8ToBytes;
const bytesToUtf8: (b: Uint8Array) => string = nobleUtils.bytesToUtf8;

// ── Constants (must match Node side) ───────────────────────

const KEY_LENGTH = 32;   // bytes (256 bits)
const IV_LENGTH = 12;    // bytes (96 bits, GCM recommended)
const TAG_LENGTH = 16;   // bytes (128 bits)

// ── Key utilities ──────────────────────────────────────────

export interface KeyPair {
  keyBytes: Uint8Array;
  keyHex: string;
  keyId: string;
}

/**
 * Secure random bytes using wx.getRandomValues.
 * API returns { errMsg, randomValues: ArrayBuffer } — extract the ArrayBuffer.
 */
function secureRandomBytes(length: number): Uint8Array {
  if (typeof wx === 'undefined' || typeof wx.getRandomValues !== 'function') {
    throw new Error('secureRandomBytes: wx.getRandomValues not available');
  }
  const raw = wx.getRandomValues({ length }) as Record<string, unknown>;
  // WeChat returns { errMsg: "getRandomValues:ok", randomValues: ArrayBuffer }
  const buffer = raw.randomValues || raw.data;
  if (!buffer || typeof (buffer as ArrayBuffer).byteLength !== 'number') {
    throw new Error(
      'wx.getRandomValues returned unrecognised structure: keys=' +
      Object.keys(raw).join(','),
    );
  }
  return new Uint8Array(buffer as ArrayBuffer, 0, length);
}

export function generateContentKey(): KeyPair {
  const keyBytes = secureRandomBytes(KEY_LENGTH);
  return {
    keyBytes,
    keyHex: bytesToHex(keyBytes),
    keyId: generateUUID(),
  };
}

export function keyFromHex(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('Invalid key hex: expected 64 hex chars (0-9, a-f, A-F)');
  }
  return hexToBytes(hex);
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
  return utf8ToBytes(json);
}

// ── Encrypt / Decrypt ──────────────────────────────────────

export function encrypt(
  plaintext: string,
  keyBytes: Uint8Array,
  aad: Uint8Array,
): string {
  const iv = secureRandomBytes(IV_LENGTH);
  const cipher = gcm(keyBytes, iv, aad);
  const plaintextBytes = utf8ToBytes(plaintext);
  // @noble/ciphers gcm: encrypt appends auth tag automatically
  const encrypted = cipher.encrypt(plaintextBytes);

  // sealed_payload = iv + ciphertext + tag
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv, 0);
  combined.set(encrypted, iv.length);
  return bytesToBase64(combined);
}

export function decrypt(
  sealedPayloadB64: string,
  keyBytes: Uint8Array,
  aad: Uint8Array,
): string {
  const combined = base64ToBytes(sealedPayloadB64);

  if (combined.length < IV_LENGTH + TAG_LENGTH + 1) {
    throw new Error('sealed_payload too short');
  }

  const iv = combined.slice(0, IV_LENGTH);
  const encrypted = combined.slice(IV_LENGTH);

  const cipher = gcm(keyBytes, iv, aad);
  const decrypted = cipher.decrypt(encrypted);
  return bytesToUtf8(decrypted);
}

// ── Internal helpers ───────────────────────────────────────

function bytesToHex(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, '0');
  }
  return hex;
}

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function bytesToBase64(bytes: Uint8Array): string {
  // Prefer wx API in production (proven to work in WeChat mini program runtime).
  // btoa fallback is for local POC testing only — real WeChat compatibility
  // must be verified via WeChat Developer Tool "Build npm" + device test.
  if (typeof wx !== 'undefined' && wx.arrayBufferToBase64) {
    return wx.arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  // POC fallback: binary string + btoa
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof wx !== 'undefined' && wx.base64ToArrayBuffer) {
    const buffer = wx.base64ToArrayBuffer(b64);
    return new Uint8Array(buffer);
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function generateUUID(): string {
  // Fallback UUID v4 for WeChat (no crypto.randomUUID)
  const hex = '0123456789abcdef';
  let uuid = '';
  for (let i = 0; i < 36; i++) {
    if (i === 8 || i === 13 || i === 18 || i === 23) {
      uuid += '-';
    } else if (i === 14) {
      uuid += '4';
    } else if (i === 19) {
      uuid += hex[(Math.random() * 4) | 8];
    } else {
      uuid += hex[(Math.random() * 16) | 0];
    }
  }
  return uuid;
}
