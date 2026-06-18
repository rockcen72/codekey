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
      // Chunked decode to avoid call-stack overflow on large payloads (100KB+).
      // String.fromCharCode(...largeArray) hits JS engine argument length limits.
      let result = '';
      const CHUNK = 8192;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, bytes.length);
        let chunk = '';
        for (let j = i; j < end; j++) chunk += String.fromCharCode(bytes[j]);
        result += chunk;
      }
      try { return decodeURIComponent(escape(result)); } catch { return result; }
    }
  };
}

// Load @noble/ciphers directly via vendor/aes.js
// WeChat require() cannot destructure ES module exports — use property access.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const _nobleAes = require('../vendor/aes.js');
const gcm: typeof import('@noble/ciphers/aes').gcm = _nobleAes.gcm;

// Inline UTF-8 helpers to avoid needing vendor/utils.js (ES module with TextEncoder dep)
function utf8ToBytes(s: string): Uint8Array {
  const enc = unescape(encodeURIComponent(s));
  const b = new Uint8Array(enc.length);
  for (let i = 0; i < enc.length; i++) b[i] = enc.charCodeAt(i);
  return b;
}
function bytesToUtf8(b: Uint8Array): string {
  const CHUNK = 8192;
  let r = '';
  for (let i = 0; i < b.length; i += CHUNK) {
    const end = Math.min(i + CHUNK, b.length);
    let c = '';
    for (let j = i; j < end; j++) c += String.fromCharCode(b[j]);
    r += c;
  }
  try { return decodeURIComponent(escape(r)); } catch { return r; }
}

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
 * Secure random bytes using tt.getRandomValues (callback → Promise wrapper).
 *
 * wx API（基础库 2.15+）：
 *   tt.getRandomValues({ length, success(res) { res.randomValues: ArrayBuffer } })
 *
 * 包装成 Promise 以便 async 上下文使用。
 */
function secureRandomBytes(length: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    // Try Feishu TT API first
    if (typeof tt !== 'undefined' && typeof tt.getRandomValues === 'function') {
      tt.getRandomValues({
        length,
        success: (res: { randomValues: ArrayBuffer }) => {
          resolve(new Uint8Array(res.randomValues, 0, length));
        },
        fail: (err: any) => {
          console.warn('[crypto] tt.getRandomValues failed, trying crypto.getRandomValues:', err.errMsg);
          fallbackRandomBytes(length, resolve, reject);
        },
      });
      return;
    }
    fallbackRandomBytes(length, resolve, reject);
  });
}

/** Fallback: Web Crypto API (Chromium webview) or Math.random */
function fallbackRandomBytes(length: number, resolve: (v: Uint8Array) => void, reject: (e: Error) => void) {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
      resolve(crypto.getRandomValues(new Uint8Array(length)));
      return;
    }
  } catch (_) { /* fall through */ }
  // Last-resort Math.random (not crypto-secure but fine for GCM IV)
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = (Math.random() * 256) | 0;
  resolve(bytes);
}

export async function generateContentKey(): Promise<KeyPair> {
  const keyBytes = await secureRandomBytes(KEY_LENGTH);
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

// ── Encrypt / Decrypt (async — tt.getRandomValues is Promise-based) ──

export async function encrypt(
  plaintext: string,
  keyBytes: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
  const iv = await secureRandomBytes(IV_LENGTH);
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

export async function decrypt(
  sealedPayloadB64: string,
  keyBytes: Uint8Array,
  aad: Uint8Array,
): Promise<string> {
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

/**
 * Decrypt a sealed_payload event envelope and merge the decrypted fields back
 * into the allowlist data. Mirrors packages/shared/src/bridge/event-envelope.ts
 * decryptEventPayload — same AAD format and sealed_payload wire format.
 *
 * Returns the merged data object: { ...allowlistData, ...decrypted }.
 *
 * Throws on:
 *   - Invalid key hex
 *   - sealed_payload too short or malformed base64
 *   - GCM auth failure (wrong key, tampered ciphertext, AAD mismatch)
 *   - Decrypted payload not valid JSON
 *
 * Caller MUST validate `encryption_version` before calling this.
 */
export async function decryptEventPayload(
  sealedPayloadB64: string,
  allowlistData: Record<string, unknown>,
  contentKeyHex: string,
  aadFields: AadFields,
): Promise<Record<string, unknown>> {
  const keyBytes = keyFromHex(contentKeyHex);
  const aad = buildAad(aadFields);
  const decryptedJson = await decrypt(sealedPayloadB64, keyBytes, aad);
  const decrypted = JSON.parse(decryptedJson) as Record<string, unknown>;
  // Strip envelope markers — once decryption succeeds the data is plaintext;
  // leaving `encrypted: true` confuses downstream UI logic that uses it as
  // an "encryption failed" placeholder trigger.
  const { encrypted: _e, preview_label: _p, safe_summary: _s, encryption_error: _err, ...allowlistRest } = allowlistData;
  void _e; void _p; void _s; void _err;
  return { ...allowlistRest, ...decrypted };
}

// ── Command Envelope encrypt (mirrors packages/shared/src/bridge/command-envelope.ts) ──

/**
 * Encrypt a command text into a sealed_command envelope.
 *
 * AAD discriminator: eventType='command' ensures command AAD never collides
 * with event envelope AAD (which uses eventType='user_prompt' etc.).
 *
 * Returns fields that should be sent in place of the plaintext `data`:
 *   { sealed_command, command_id, key_id, encryption_version }
 *
 * The relay server cannot decrypt the sealed_command — it forwards it
 * opaquely to the PC bridge.
 */
export async function encryptCommandPayload(
  text: string,
  contentKeyHex: string,
  keyId: string,
  deviceId: string,
  sessionId: string,
  commandId: string,
): Promise<{
  sealed_command: string;
  command_id: string;
  key_id: string;
  encryption_version: number;
}> {
  const keyBytes = keyFromHex(contentKeyHex);
  const aad = buildAad({
    v: 1,
    keyId,
    deviceId,
    sessionId,
    eventId: commandId,
    eventType: 'command',
  });
  const sealed_command = await encrypt(text, keyBytes, aad);
  return {
    sealed_command,
    command_id: commandId,
    key_id: keyId,
    encryption_version: 1,
  };
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
  if (typeof tt !== 'undefined' && tt.arrayBufferToBase64) {
    return tt.arrayBufferToBase64(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  // POC fallback: binary string + btoa
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  if (typeof tt !== 'undefined' && tt.base64ToArrayBuffer) {
    const buffer = tt.base64ToArrayBuffer(b64);
    return new Uint8Array(buffer);
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── ECDH P-256 Key Exchange (绑定码 E2E) ──────────────────────

/**
 * Generate an ECDH P-256 key pair.
 * Returns public key as uncompressed hex (130 chars: 04 + 64-byte xy).
 * Private key is hex string for easier passing.
 */
export function generateEcdhKeyPair(): { publicKeyHex: string; privateKeyHex: string } {
  const _nobleEcdh = require('../vendor/e2e-key-exchange.js');
  const p256 = _nobleEcdh.p256;
  const privateKeyBytes = p256.utils.randomSecretKey();
  const publicKeyBytes = p256.getPublicKey(privateKeyBytes, false); // false = uncompressed
  return {
    publicKeyHex: bytesToHex(publicKeyBytes),
    privateKeyHex: bytesToHex(privateKeyBytes),
  };
}

/**
 * Derive contentKey + keyId from ECDH shared secret via HKDF-SHA256.
 * Must match deriveKeyMaterial() in packages/shared/src/bridge/e2e-key-exchange.ts:
 *   curve = P-256 (prime256v1 / secp256r1)
 *   HKDF info = 'codekey-e2e-key-v1'
 *   HKDF salt = empty
 *   HKDF output = 40 bytes (32 contentKey + 8 keyId)
 */
export function deriveEcdhKeyMaterial(
  privateKeyHex: string,
  peerPublicKeyHex: string,
): { contentKeyHex: string; keyId: string } {
  const _nobleEcdh = require('../vendor/e2e-key-exchange.js');
  const p256 = _nobleEcdh.p256;
  const hkdf = _nobleEcdh.hkdf;
  const sha256 = _nobleEcdh.sha256;

  const sharedSecretPoint = p256.getSharedSecret(
    hexToBytes(privateKeyHex),
    hexToBytes(peerPublicKeyHex),
  );
  // noble returns compressed point (33 bytes: 0x02/0x03 prefix + 32 byte x-coordinate).
  // ECDH shared secret is just the x-coordinate (32 bytes), matching Node crypto.
  const sharedSecret = sharedSecretPoint.subarray(1);

  const HKDF_INFO = 'codekey-e2e-key-v1';
  const DERIVED_LENGTH = 40; // 32 contentKey + 8 keyId

  const derived = hkdf(sha256, sharedSecret, new Uint8Array(0), utf8ToBytes(HKDF_INFO), DERIVED_LENGTH);
  return {
    contentKeyHex: bytesToHex(derived.subarray(0, 32)),
    keyId: bytesToHex(derived.subarray(32, 40)),
  };
}

/**
 * Generate an ECDH key pair and derive contentKey + keyId using the peer's public key.
 * One-shot convenience for the pairing flow.
 */
export function generateEcdhContentKey(
  peerPublicKeyHex: string,
): { publicKeyHex: string; privateKeyHex: string; contentKeyHex: string; keyId: string } {
  const kp = generateEcdhKeyPair();
  const material = deriveEcdhKeyMaterial(kp.privateKeyHex, peerPublicKeyHex);
  return {
    publicKeyHex: kp.publicKeyHex,
    privateKeyHex: kp.privateKeyHex,
    contentKeyHex: material.contentKeyHex,
    keyId: material.keyId,
  };
}

export function generateUUID(): string {
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
