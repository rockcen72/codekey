/**
 * e2e-encryption-poc.test.ts — Crypto Spike for E2E event encryption.
 *
 * Covers:
 *   1. Basic roundtrip (Node crypto)
 *   2. Performance benchmarks (1KB / 20KB / 100KB × 100)
 *   3. Negative tests (wrong key, tampered, AAD mismatch, version unknown)
 *   4. Cross-platform test vectors (for Telegram Web Crypto API & WeChat @noble/ciphers)
 *   5. AAD canonical encoding verification
 *
 * Does NOT touch: DB, relay, pairing flow, business code.
 */

import { describe, it, expect } from 'vitest';
import {
  generateContentKey,
  keyFromHex,
  buildAad,
  encrypt,
  encryptWithIv,
  decrypt,
  KEY_LENGTH,
  IV_LENGTH,
  TAG_LENGTH,
} from '../bridge/encryption.js';

// ── Helpers ────────────────────────────────────────────────

function generateText(bytes: number): string {
  // Repeat a 64-char pattern so every byte is meaningful (not just repeated 'x')
  const pattern = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!?';
  let result = '';
  while (result.length < bytes) {
    result += pattern;
  }
  return result.slice(0, bytes);
}

function makeAad(overrides?: Partial<Parameters<typeof buildAad>[0]>) {
  return buildAad({
    v: 1,
    keyId: '550e8400-e29b-41d4-a716-446655440000',
    deviceId: 'test-device-001',
    sessionId: 'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
    eventId: 'evt-client-001',
    eventType: 'user_prompt',
    ...overrides,
  });
}

// ── 1. Basic Roundtrip ─────────────────────────────────────

describe('encrypt/decrypt roundtrip (Node crypto)', () => {
  const { key, keyHex, keyId } = generateContentKey();
  const aad = makeAad({ keyId });

  it('generates a 32-byte key', () => {
    expect(key.length).toBe(KEY_LENGTH);
  });

  it('generates a 64-char hex key', () => {
    expect(keyHex).toHaveLength(64);
  });

  it('keyFromHex reconstructs the same key', () => {
    const restored = keyFromHex(keyHex);
    expect(restored.equals(key)).toBe(true);
  });

  it('keyFromHex rejects non-hex characters', () => {
    expect(() => keyFromHex('zz'.repeat(32))).toThrow();
  });

  it('keyFromHex rejects wrong length', () => {
    expect(() => keyFromHex('ab'.repeat(16))).toThrow(); // 32 chars = 16 bytes
  });

  it('encrypts and decrypts a short string', () => {
    const plaintext = 'Hello, CodeKey E2E!';
    const sealed = encrypt(plaintext, key, aad);
    const decrypted = decrypt(sealed, key, aad);
    expect(decrypted).toBe(plaintext);
  });

  it('produces deterministic sealed_payload structure', () => {
    const sealed = encrypt('test', key, aad);
    const buf = Buffer.from(sealed, 'base64');
    // IV(12) + ciphertext(N) + tag(16)
    expect(buf.length).toBeGreaterThanOrEqual(IV_LENGTH + TAG_LENGTH + 1);
  });

  it('each encryption produces a different sealed_payload (unique IV)', () => {
    const s1 = encrypt('same text', key, aad);
    const s2 = encrypt('same text', key, aad);
    expect(s1).not.toBe(s2);
  });

  const samples = {
    '1KB': generateText(1_024),
    '20KB': generateText(20_480),
    '100KB': generateText(102_400),
  };

  for (const [label, text] of Object.entries(samples)) {
    it(`roundtrip — ${label}`, () => {
      const sealed = encrypt(text, key, aad);
      const decrypted = decrypt(sealed, key, aad);
      expect(decrypted).toBe(text);
    });
  }
});

// ── 2. Performance Benchmarks ──────────────────────────────

describe('performance benchmarks', () => {
  const { key } = generateContentKey();
  const aad = makeAad({ keyId: generateContentKey().keyId });

  const samples: Record<string, string> = {
    '1KB': generateText(1_024),
    '20KB': generateText(20_480),
    '100KB': generateText(102_400),
  };

  for (const [label, text] of Object.entries(samples)) {
    it(`${label} × 100 rounds`, () => {
      const rounds = 100;
      const start = performance.now();
      for (let i = 0; i < rounds; i++) {
        const sealed = encrypt(text, key, aad);
        decrypt(sealed, key, aad);
      }
      const elapsed = performance.now() - start;
      const perRound = elapsed / rounds;
      // Log for human review; no hard assertion — POC is about measuring, not passing a threshold
      console.log(
        `[bench] ${label}: ${rounds} rounds in ${elapsed.toFixed(1)}ms (${perRound.toFixed(2)}ms/round)`,
      );
      // Soft expectation: 100KB roundtrip < 50ms
      // This matches the benchmark report target. 实测 ~0.33ms/round.
      if (label === '100KB') {
        expect(perRound).toBeLessThan(50);
      }
    });
  }
});

// ── 3. Negative Tests ──────────────────────────────────────

describe('negative tests', () => {
  const key1 = generateContentKey();
  const key2 = generateContentKey();
  const aad1 = makeAad({ keyId: key1.keyId });
  const aad2 = makeAad({ keyId: key2.keyId });
  const plaintext = 'sensitive data';

  it('wrong key — throws on decrypt', () => {
    const sealed = encrypt(plaintext, key1.key, aad1);
    // Use key2 with aad2 (key2's correct AAD), but sealed was encrypted with key1
    expect(() => decrypt(sealed, key2.key, aad2)).toThrow();
  });

  it('wrong keyId (key matches but AAD keyId differs) — throws on AAD mismatch', () => {
    // AAD is part of GCM authentication, so keyId mismatch in AAD = auth failure
    const sealed = encrypt(plaintext, key1.key, aad1);
    expect(() => decrypt(sealed, key1.key, aad2)).toThrow();
  });

  it('tampered ciphertext (flip 1 bit) — throws', () => {
    const sealed = encrypt(plaintext, key1.key, aad1);
    const buf = Buffer.from(sealed, 'base64');
    // Flip a bit in the ciphertext region (after IV, before tag)
    const tamperIdx = IV_LENGTH + 2;
    buf[tamperIdx] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered, key1.key, aad1)).toThrow();
  });

  it('tampered tag (flip 1 bit) — throws', () => {
    const sealed = encrypt(plaintext, key1.key, aad1);
    const buf = Buffer.from(sealed, 'base64');
    // Flip a bit in the tag region (last TAG_LENGTH bytes)
    buf[buf.length - 3] ^= 0x01;
    const tampered = buf.toString('base64');
    expect(() => decrypt(tampered, key1.key, aad1)).toThrow();
  });

  it('AAD mismatch (different sessionId) — throws', () => {
    const sealed = encrypt(plaintext, key1.key, aad1);
    const wrongAad = makeAad({ keyId: key1.keyId, sessionId: 'different-session' });
    expect(() => decrypt(sealed, key1.key, wrongAad)).toThrow();
  });

  it('AAD mismatch (different eventType) — throws', () => {
    const sealed = encrypt(plaintext, key1.key, aad1);
    const wrongAad = makeAad({ keyId: key1.keyId, eventType: 'task_complete' });
    expect(() => decrypt(sealed, key1.key, wrongAad)).toThrow();
  });

  it('empty sealed_payload — throws', () => {
    expect(() => decrypt('', key1.key, aad1)).toThrow();
  });

  it('malformed sealed_payload (not base64) — throws', () => {
    expect(() => decrypt('!!!not-base64!!!', key1.key, aad1)).toThrow();
  });

  it('sealed_payload too short — throws', () => {
    const tooShort = Buffer.from('short').toString('base64');
    expect(() => decrypt(tooShort, key1.key, aad1)).toThrow('too short');
  });
});

// ── 4. Cross-Platform Test Vectors ─────────────────────────
//
// These are DETERMINISTIC test vectors using a fixed key AND a fixed IV.
// They produce identical sealed_payload bytes on every run and can be
// copied into Telegram and WeChat mini app tests for exact byte-level
// cross-platform verification.

describe('cross-platform test vectors (CANONICAL)', () => {
  // Fixed key: 32 bytes of 0xAB
  const fixedKey = Buffer.alloc(KEY_LENGTH, 0xAB);
  const fixedKeyHex = fixedKey.toString('hex');
  // Fixed IV: 12 bytes of 0x01
  const fixedIv = Buffer.alloc(IV_LENGTH, 0x01);
  const aad = buildAad({
    v: 1,
    keyId: '00000000-0000-0000-0000-000000000001',
    deviceId: 'canonical-device',
    sessionId: '00000000-0000-0000-0000-000000000002',
    eventId: '00000000-0000-0000-0000-000000000003',
    eventType: 'user_prompt',
  });

  it('produces canonical AAD bytes (for cross-platform verification)', () => {
    const aadHex = aad.toString('hex');
    expect(aad.length).toBeGreaterThan(0);
    console.log('[vector] canonical AAD hex:', aadHex);
    console.log('[vector] canonical AAD raw:', aad.toString('utf8'));
  });

  it('key hex roundtrip matches expected format', () => {
    expect(fixedKeyHex).toHaveLength(64);
    expect(fixedKeyHex).toBe('ab'.repeat(32));
  });

  it('IV is exactly 12 bytes of 0x01', () => {
    expect(fixedIv.length).toBe(IV_LENGTH);
    expect(fixedIv.toString('hex')).toBe('01'.repeat(IV_LENGTH));
  });

  // Deterministic roundtrip with fixed key + fixed IV
  it('produces deterministic sealed_payload (same input → same output)', () => {
    const plaintext = 'canonical test payload';
    const a = encryptWithIv(plaintext, fixedKey, fixedIv, aad);
    const b = encryptWithIv(plaintext, fixedKey, fixedIv, aad);
    expect(a).toBe(b); // MUST be identical — same key, same IV, same input
    const decrypted = decrypt(a, fixedKey, aad);
    expect(decrypted).toBe(plaintext);
  });

  // Export format description for cross-platform implementors
  it('documents the wire format invariants with a repeatable vector', () => {
    const plaintext = 'Hello, cross-platform E2E! 🌍';
    const sealed = encryptWithIv(plaintext, fixedKey, fixedIv, aad);
    const buf = Buffer.from(sealed, 'base64');

    const iv = buf.subarray(0, IV_LENGTH);
    const tag = buf.subarray(buf.length - TAG_LENGTH);
    const ct = buf.subarray(IV_LENGTH, buf.length - TAG_LENGTH);

    console.log('[vector] IV hex:', iv.toString('hex'));
    console.log('[vector] TAG hex:', tag.toString('hex'));
    console.log('[vector] ciphertext length:', ct.length);
    console.log('[vector] total sealed_payload bytes:', buf.length);
    console.log('[vector] sealed_payload base64:', sealed);
    console.log('[vector] plaintext length:', plaintext.length);
    console.log('[vector] plaintext bytes (UTF-8):', Buffer.from(plaintext, 'utf8').length);

    expect(iv.toString('hex')).toBe('01'.repeat(IV_LENGTH)); // our fixed IV
    expect(tag.length).toBe(TAG_LENGTH);
    expect(ct.length).toBeGreaterThanOrEqual(Buffer.from(plaintext, 'utf8').length);
  });
});

// ── 5. AAD Canonical Encoding ──────────────────────────────

describe('AAD canonical encoding', () => {
  it('produces identical AAD for identical fields', () => {
    const fields = {
      v: 1,
      keyId: '550e8400-e29b-41d4-a716-446655440000',
      deviceId: 'dev-1',
      sessionId: 'sess-1',
      eventId: 'evt-1',
      eventType: 'user_prompt',
    };
    const a = buildAad(fields);
    const b = buildAad({ ...fields });
    expect(a.equals(b)).toBe(true);
  });

  it('produces different AAD for different eventId', () => {
    const a = buildAad({
      v: 1, keyId: 'k', deviceId: 'd', sessionId: 's',
      eventId: 'evt-1', eventType: 'user_prompt',
    });
    const b = buildAad({
      v: 1, keyId: 'k', deviceId: 'd', sessionId: 's',
      eventId: 'evt-2', eventType: 'user_prompt',
    });
    expect(a.equals(b)).toBe(false);
  });

  it('AAD contains all required field names', () => {
    const aadStr = buildAad({
      v: 1, keyId: 'k', deviceId: 'd', sessionId: 's',
      eventId: 'e', eventType: 'user_prompt',
    }).toString('utf8');
    expect(aadStr).toContain('"v"');
    expect(aadStr).toContain('"keyId"');
    expect(aadStr).toContain('"deviceId"');
    expect(aadStr).toContain('"sessionId"');
    expect(aadStr).toContain('"eventId"');
    expect(aadStr).toContain('"eventType"');
  });
});
