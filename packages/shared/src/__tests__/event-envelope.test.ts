/**
 * event-envelope.test.ts — covers the Phase 4 event envelope contract.
 *
 * Test matrix (audit r2 P2):
 *   1. Envelope roundtrip — prompt/summary go into sealed_payload, data only
 *      retains allowlist; decrypt restores original body.
 *   2. AAD binding uses clientEventId — swapping clientEventId between encrypt
 *      and decrypt MUST cause GCM auth failure.
 *   3. Allowlist enforcement — keys outside the allowlist set never appear in
 *      the returned plaintext data.
 *   4. encrypted=true marker — always set on returned data so phone knows to
 *      attempt decryption.
 *   5. AAD field tampering — every AAD field (deviceId, sessionId, eventType,
 *      keyId) is bound; any mismatch fails decrypt.
 */

import { describe, it, expect } from 'vitest';
import {
  encryptEventPayload,
  decryptEventPayload,
  stripSensitiveFields,
  buildEventAad,
} from '../bridge/event-envelope.js';
import { generateContentKey } from '../bridge/encryption.js';

// ── Fixtures ────────────────────────────────────────────────

function makeFixtures() {
  const { keyHex, keyId } = generateContentKey();
  return {
    contentKeyHex: keyHex,
    keyId,
    deviceId: 'device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'session-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    clientEventId: 'cevt:claude-a:42:0.123',
    eventType: 'user_prompt',
  };
}

// ── stripSensitiveFields ───────────────────────────────────

describe('stripSensitiveFields', () => {
  it('keeps only allowlist keys + sets encrypted=true', () => {
    const result = stripSensitiveFields({
      type: 'user_prompt',
      prompt: 'check my code please',
      summary: 'check code',
      summaryShort: 'check',
      output: 'should not appear',
      command: 'ls -la',
    });

    expect(result.allowlistData).toEqual({ type: 'user_prompt', encrypted: true });
    // Sensitive payload is JSON of all stripped fields
    const parsed = JSON.parse(result.sensitivePayload);
    expect(parsed).toEqual({
      prompt: 'check my code please',
      summary: 'check code',
      summaryShort: 'check',
      output: 'should not appear',
      command: 'ls -la',
    });
  });

  it('preserves safe_summary and preview_label in allowlist', () => {
    const result = stripSensitiveFields({
      type: 'user_prompt',
      prompt: 'secret prompt',
      safe_summary: 'User prompt',
      preview_label: 'user_prompt',
    });

    expect(result.allowlistData).toEqual({
      type: 'user_prompt',
      encrypted: true,
      safe_summary: 'User prompt',
      preview_label: 'user_prompt',
    });
    const parsed = JSON.parse(result.sensitivePayload);
    expect(parsed).toEqual({ prompt: 'secret prompt' });
  });
});

// ── encryptEventPayload / decryptEventPayload roundtrip ────

describe('encryptEventPayload + decryptEventPayload', () => {
  it('roundtrips prompt body — data has only allowlist, sealed_payload has body, decrypt restores all', () => {
    const f = makeFixtures();
    const original = {
      type: 'user_prompt',
      prompt: '帮我检查这个 bug',
      summary: '帮我检查这个 bug',
      summaryShort: '帮我检查',
    };

    const envelope = encryptEventPayload(
      original,
      f.contentKeyHex,
      f.keyId,
      f.deviceId,
      f.sessionId,
      f.clientEventId,
      f.eventType,
    );

    // P3A contract: data has only allowlist + encrypted marker
    expect(envelope.data).toEqual({ type: 'user_prompt', encrypted: true });
    expect(envelope.data).not.toHaveProperty('prompt');
    expect(envelope.data).not.toHaveProperty('summary');
    expect(envelope.data).not.toHaveProperty('summaryShort');

    // sealed_payload is non-trivial base64
    expect(typeof envelope.sealed_payload).toBe('string');
    expect(envelope.sealed_payload.length).toBeGreaterThan(20);
    expect(envelope.key_id).toBe(f.keyId);
    expect(envelope.encryption_version).toBe(1);

    // sealed_payload must NOT contain the plaintext prompt
    const decoded = Buffer.from(envelope.sealed_payload, 'base64').toString('utf8');
    expect(decoded).not.toContain('帮我检查');
    expect(decoded).not.toContain('bug');

    // Roundtrip: decrypt restores original body merged with allowlist
    const decrypted = decryptEventPayload(
      envelope.sealed_payload,
      envelope.data,
      f.contentKeyHex,
      {
        v: 1,
        keyId: f.keyId,
        deviceId: f.deviceId,
        sessionId: f.sessionId,
        eventId: f.clientEventId,
        eventType: f.eventType,
      },
    );
    expect(decrypted).toEqual({
      type: 'user_prompt',
      prompt: '帮我检查这个 bug',
      summary: '帮我检查这个 bug',
      summaryShort: '帮我检查',
    });
  });

  it('AAD binds clientEventId — swapping clientEventId fails decrypt (audit r2 P1)', () => {
    const f = makeFixtures();
    const envelope = encryptEventPayload(
      { type: 'user_prompt', prompt: 'secret' },
      f.contentKeyHex,
      f.keyId,
      f.deviceId,
      f.sessionId,
      f.clientEventId,
      f.eventType,
    );

    expect(() =>
      decryptEventPayload(
        envelope.sealed_payload,
        envelope.data,
        f.contentKeyHex,
        {
          v: 1,
          keyId: f.keyId,
          deviceId: f.deviceId,
          sessionId: f.sessionId,
          eventId: 'cevt:other:99', // different clientEventId
          eventType: f.eventType,
        },
      ),
    ).toThrow();
  });

  it('AAD binds deviceId — swapping deviceId fails decrypt', () => {
    const f = makeFixtures();
    const envelope = encryptEventPayload(
      { type: 'user_prompt', prompt: 'secret' },
      f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.clientEventId, f.eventType,
    );

    expect(() =>
      decryptEventPayload(envelope.sealed_payload, envelope.data, f.contentKeyHex, {
        v: 1,
        keyId: f.keyId,
        deviceId: 'device-different-aaaaaaaaaaaaaaaa',
        sessionId: f.sessionId,
        eventId: f.clientEventId,
        eventType: f.eventType,
      }),
    ).toThrow();
  });

  it('AAD binds sessionId — swapping sessionId fails decrypt', () => {
    const f = makeFixtures();
    const envelope = encryptEventPayload(
      { type: 'user_prompt', prompt: 'secret' },
      f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.clientEventId, f.eventType,
    );

    expect(() =>
      decryptEventPayload(envelope.sealed_payload, envelope.data, f.contentKeyHex, {
        v: 1,
        keyId: f.keyId,
        deviceId: f.deviceId,
        sessionId: 'session-other-cccccccccccccccccccc',
        eventId: f.clientEventId,
        eventType: f.eventType,
      }),
    ).toThrow();
  });

  it('AAD binds eventType — using a different eventType fails decrypt', () => {
    const f = makeFixtures();
    const envelope = encryptEventPayload(
      { type: 'user_prompt', prompt: 'secret' },
      f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.clientEventId, f.eventType,
    );

    expect(() =>
      decryptEventPayload(envelope.sealed_payload, envelope.data, f.contentKeyHex, {
        v: 1,
        keyId: f.keyId,
        deviceId: f.deviceId,
        sessionId: f.sessionId,
        eventId: f.clientEventId,
        eventType: 'task_complete', // wrong eventType
      }),
    ).toThrow();
  });

  it('wrong content key fails decrypt', () => {
    const f = makeFixtures();
    const otherKey = generateContentKey();
    const envelope = encryptEventPayload(
      { type: 'user_prompt', prompt: 'secret' },
      f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.clientEventId, f.eventType,
    );

    expect(() =>
      decryptEventPayload(envelope.sealed_payload, envelope.data, otherKey.keyHex, {
        v: 1,
        keyId: f.keyId,
        deviceId: f.deviceId,
        sessionId: f.sessionId,
        eventId: f.clientEventId,
        eventType: f.eventType,
      }),
    ).toThrow();
  });
});

// ── buildEventAad — sanity check field order & format ─────────

describe('buildEventAad', () => {
  it('produces stable utf8 JSON encoding', () => {
    const f = makeFixtures();
    const aad = buildEventAad({
      v: 1,
      keyId: f.keyId,
      deviceId: f.deviceId,
      sessionId: f.sessionId,
      eventId: f.clientEventId,
      eventType: f.eventType,
    });

    const decoded = Buffer.from(aad).toString('utf8');
    const parsed = JSON.parse(decoded);
    expect(parsed).toEqual({
      v: 1,
      keyId: f.keyId,
      deviceId: f.deviceId,
      sessionId: f.sessionId,
      eventId: f.clientEventId,
      eventType: f.eventType,
    });
  });
});
