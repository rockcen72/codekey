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

// ECDH P-256 — must match packages/shared/src/bridge/e2e-key-exchange.ts
const HKDF_INFO = 'codekey-e2e-key-v1';
const ECDH_CURVE = 'P-256';
const ECDH_KEY_LENGTH = 256; // bits (shared secret)
const DERIVED_OUTPUT_LENGTH = 320; // bits (32 bytes contentKey + 8 bytes keyId)

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
  // Slice from the view's actual byteOffset, not from 0.
  // A Uint8Array created via .subarray() or new Uint8Array(buffer, offset, len)
  // shares the underlying ArrayBuffer; passing the whole buffer to Web Crypto API
  // would include bytes outside the intended range (e.g. IV mixed into ciphertext).
  return new Uint8Array(
    v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength) as ArrayBuffer,
  );
}

// ── ECDH P-256 Key Exchange ────────────────────────────────

export interface EcdhKeyPair {
  publicKeyHex: string;
  privateKey: CryptoKey;
}

/** Generate an ECDH P-256 keypair, exporting public key as uncompressed hex (130 chars). */
export async function generateEcdhKeyPair(): Promise<EcdhKeyPair> {
  const keyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: ECDH_CURVE },
    true,
    ['deriveBits'],
  );
  const rawPub = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const pubBytes = new Uint8Array(rawPub);
  // P-256 raw public key is 65 bytes: 0x04 prefix + 32 x + 32 y
  if (pubBytes[0] !== 0x04 || pubBytes.length !== 65) {
    throw new Error('Unexpected P-256 public key format');
  }
  return { publicKeyHex: buf2hex(pubBytes), privateKey: keyPair.privateKey };
}

/** Import a peer's uncompressed P-256 public key from hex. */
async function importPeerPublicKey(publicKeyHex: string): Promise<CryptoKey> {
  const raw = hex2buf(publicKeyHex);
  if (raw[0] !== 0x04 || raw.length !== 65) {
    throw new Error('Invalid P-256 public key: expected 65 bytes with 0x04 prefix');
  }
  return crypto.subtle.importKey(
    'raw',
    asBuf(raw),
    { name: 'ECDH', namedCurve: ECDH_CURVE },
    false,
    [],
  );
}

/** Compute ECDH shared secret (256-bit) from our private key and peer's public key. */
async function computeSharedSecret(privKey: CryptoKey, peerPubKeyHex: string): Promise<ArrayBuffer> {
  const peerPub = await importPeerPublicKey(peerPubKeyHex);
  return crypto.subtle.deriveBits(
    { name: 'ECDH', public: peerPub },
    privKey,
    ECDH_KEY_LENGTH,
  );
}

/** Derive contentKeyHex[32] + keyId[8] from ECDH shared secret via HKDF-SHA256.
 *  Must match deriveKeyMaterial() in packages/shared/src/bridge/e2e-key-exchange.ts. */
export async function deriveKeyMaterial(privKey: CryptoKey, peerPubKeyHex: string): Promise<{ contentKeyHex: string; keyId: string }> {
  const sharedSecret = await computeSharedSecret(privKey, peerPubKeyHex);

  // Import shared secret as HKDF base key
  const hkdfKey = await crypto.subtle.importKey(
    'raw',
    asBuf(new Uint8Array(sharedSecret)),
    { name: 'HKDF' },
    false,
    ['deriveBits'],
  );

  const derived = await crypto.subtle.deriveBits(
    {
      name: 'HKDF',
      hash: 'SHA-256',
      salt: new Uint8Array(0),
      info: new TextEncoder().encode(HKDF_INFO),
    },
    hkdfKey,
    DERIVED_OUTPUT_LENGTH,
  );

  const bytes = new Uint8Array(derived);
  const contentKeyHex = buf2hex(bytes.subarray(0, 32));
  const keyId = buf2hex(bytes.subarray(32, 40));
  return { contentKeyHex, keyId };
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

// ── Event Envelope decrypt (mirrors packages/shared/src/bridge/event-envelope.ts) ──

/**
 * Decrypt a sealed_payload event envelope and merge the decrypted fields back
 * into the allowlist data. Mirrors the Node-side decryptEventPayload() — same
 * AAD format and sealed_payload wire format, just async because Web Crypto.
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
  const aad = buildAad(aadFields);
  const decryptedJson = await decrypt(sealedPayloadB64, contentKeyHex, aad);
  const decrypted = JSON.parse(decryptedJson) as Record<string, unknown>;
  // Strip envelope markers — once decryption succeeds the data is plaintext;
  // leaving `encrypted: true` confuses downstream getEncryptedPlaceholder().
  // preview_label / safe_summary / encryption_error are also envelope-only.
  const { encrypted: _e, preview_label: _p, safe_summary: _s, encryption_error: _err, ...allowlistRest } = allowlistData;
  void _e; void _p; void _s; void _err;
  return { ...allowlistRest, ...decrypted };
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
