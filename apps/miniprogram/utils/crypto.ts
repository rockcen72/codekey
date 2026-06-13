/**
 * crypto.ts — AES-256-GCM symmetric encryption for WeChat mini program.
 *
 * Uses @noble/ciphers (pure JS, ~5KB gzip), which is the only audited
 * AEAD library that reliably works in the WeChat mini program JS runtime
 * (JavaScriptCore on iOS, V8 on Android).
 *
 * Wire format must match packages/shared/src/bridge/encryption.ts EXACTLY:
 *   sealed_payload = base64(iv[12] ++ ciphertext ++ tag[16])
 *
 * AAD format (identical across platforms):
 *   utf8(JSON.stringify({ v, keyId, deviceId, sessionId, eventId, eventType }))
 */

import { gcm } from '@noble/ciphers/aes';
import { utf8ToBytes, bytesToUtf8 } from '@noble/ciphers/utils';

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

function secureRandomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  // WeChat mini program: try wx.getRandomValues first (secure RNG),
  // fall back to Math.random for POC environments without the WeChat runtime.
  if (typeof wx !== 'undefined' && wx.getRandomValues) {
    wx.getRandomValues({ length }).data.forEach((v: number, i: number) => { bytes[i] = v; });
  } else {
    for (let i = 0; i < length; i++) {
      bytes[i] = (Math.random() * 256) | 0;
    }
  }
  return bytes;
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
  if (hex.length !== KEY_LENGTH * 2) {
    throw new Error('Invalid key length: expected ' + (KEY_LENGTH * 2) + ' hex chars, got ' + hex.length);
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
  // WeChat mini program supports btoa natively
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  // wx.arrayBufferToBase64 可能可用，但 btoa 更跨平台
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
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
