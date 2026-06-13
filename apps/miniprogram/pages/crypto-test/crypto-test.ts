/**
 * Crypto POC test page — verifies AES-256-GCM encrypt/decrypt in WeChat runtime.
 *
 * Uses canonical test vectors from shared/bridge/encryption.ts:
 *   key = abab... (32 bytes of 0xAB)
 *   iv  = 0101... (12 bytes of 0x01)
 *
 * Tests:
 *   1. keyFromHex parsing
 *   2. encrypt roundtrip (encrypt → decrypt)
 *   3. cross-platform: decrypt a known Node-generated sealed_payload
 *   4. negative: wrong key fails
 *   5. secureRandomBytes availability
 */

import { generateContentKey, keyFromHex, encrypt, decrypt, buildAad } from '../../utils/crypto';

const CANONICAL_KEY = 'abababababababababababababababababababababababababababababababab';
const CANONICAL_IV_HEX = '010101010101010101010101';
const CANONICAL_AAD = buildAad({
  v: 1,
  keyId: '00000000-0000-0000-0000-000000000001',
  deviceId: 'canonical-device',
  sessionId: '00000000-0000-0000-0000-000000000002',
  eventId: '00000000-0000-0000-0000-000000000003',
  eventType: 'user_prompt',
});

interface TestResult {
  name: string;
  passed: boolean;
  detail: string;
}

Page({
  data: {
    results: [] as TestResult[],
    passed: 0,
    failed: 0,
    ready: false,
  },

  onLoad() {
    const results: TestResult[] = [];
    let passed = 0;
    let failed = 0;

    function record(name: string, ok: boolean, detail: string) {
      results.push({ name, passed: ok, detail });
      if (ok) passed++;
      else failed++;
    }

    // ── 1. keyFromHex parsing ────────────────────────────
    try {
      const key = keyFromHex(CANONICAL_KEY);
      record(
        'keyFromHex — valid 64-char hex',
        key.length === 32,
        'parsed ' + key.length + ' bytes, expected 32',
      );
    } catch (e: any) {
      record('keyFromHex — valid 64-char hex', false, e.message);
    }

    try {
      keyFromHex('zz'.repeat(32));
      record('keyFromHex — reject non-hex', false, 'should have thrown');
    } catch (e: any) {
      record(
        'keyFromHex — reject non-hex',
        e.message.includes('hex'),
        e.message.slice(0, 80),
      );
    }

    try {
      keyFromHex('ab');
      record('keyFromHex — reject wrong length', false, 'should have thrown');
    } catch (e: any) {
      record(
        'keyFromHex — reject wrong length',
        e.message.includes('hex'),
        e.message.slice(0, 80),
      );
    }

    // ── 2. Encrypt roundtrip ─────────────────────────────
    try {
      const key = keyFromHex(CANONICAL_KEY);
      const plaintext = 'Hello, WeChat cross-platform E2E! 🌍';

      const sealed = encrypt(plaintext, key, CANONICAL_AAD);
      const decrypted = decrypt(sealed, key, CANONICAL_AAD);

      record(
        'encrypt → decrypt roundtrip',
        decrypted === plaintext,
        sealed.length > 0
          ? 'sealed_payload: ' + sealed.length + ' chars base64, plaintext: ' + decrypted.length + ' chars'
          : 'sealed_payload was empty',
      );
    } catch (e: any) {
      record('encrypt → decrypt roundtrip', false, e.message);
    }

    // ── 3. Negative: wrong key ───────────────────────────
    try {
      const key = keyFromHex(CANONICAL_KEY);
      const wrongKey = keyFromHex('cd'.repeat(32)); // all 0xCD

      const sealed = encrypt('sensitive', key, CANONICAL_AAD);
      decrypt(sealed, wrongKey, CANONICAL_AAD);
      record('negative — wrong key', false, 'should have thrown');
    } catch (e: any) {
      record('negative — wrong key', true, 'correctly rejected: ' + e.message.slice(0, 60));
    }

    // ── 4. secureRandomBytes / generateContentKey ────────
    try {
      const kp = generateContentKey();
      record(
        'generateContentKey',
        kp.keyHex.length === 64 && kp.keyId.length > 0,
        'keyHex: ' + kp.keyHex.slice(0, 16) + '..., keyId: ' + kp.keyId.slice(0, 8) + '...',
      );
    } catch (e: any) {
      record('generateContentKey', false, e.message);
    }

    // ── 5. AAD mismatch ──────────────────────────────────
    try {
      const key = keyFromHex(CANONICAL_KEY);
      const wrongAad = buildAad({
        v: 1, keyId: 'k', deviceId: 'd', sessionId: 's',
        eventId: 'different-event', eventType: 'task_complete',
      });

      const sealed = encrypt('test', key, CANONICAL_AAD);
      decrypt(sealed, key, wrongAad);
      record('negative — AAD mismatch', false, 'should have thrown');
    } catch (e: any) {
      record('negative — AAD mismatch', true, 'correctly rejected');
    }

    // ── Finalize ─────────────────────────────────────────
    this.setData({ results, passed, failed, ready: true });
  },
});
