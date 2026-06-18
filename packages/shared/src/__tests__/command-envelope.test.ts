import { describe, it, expect } from 'vitest';
import {
  encryptCommandPayload,
  decryptCommandPayload,
  buildCommandAad,
} from '../bridge/command-envelope.js';
import { generateContentKey, buildAad, decrypt as rawDecrypt, keyFromHex } from '../bridge/encryption.js';

function makeFixtures() {
  const { keyHex, keyId } = generateContentKey();
  return {
    contentKeyHex: keyHex,
    keyId,
    deviceId: 'device-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sessionId: 'session-bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    commandId: 'cmd-cccccccccccccccccccccccccccccccc',
  };
}

describe('encryptCommandPayload + decryptCommandPayload', () => {
  it('roundtrips command text', () => {
    const f = makeFixtures();
    const text = '查询上海天气';

    const envelope = encryptCommandPayload(
      text,
      f.contentKeyHex,
      f.keyId,
      f.deviceId,
      f.sessionId,
      f.commandId,
    );

    expect(envelope.sealed_command).toBeTruthy();
    expect(typeof envelope.sealed_command).toBe('string');
    expect(envelope.sealed_command.length).toBeGreaterThan(20);
    expect(envelope.command_id).toBe(f.commandId);
    expect(envelope.key_id).toBe(f.keyId);
    expect(envelope.encryption_version).toBe(1);

    const decrypted = decryptCommandPayload(
      envelope.sealed_command,
      f.contentKeyHex,
      {
        v: 1,
        keyId: f.keyId,
        deviceId: f.deviceId,
        sessionId: f.sessionId,
        commandId: f.commandId,
      },
    );

    expect(decrypted).toBe(text);
  });

  it('sealed_command does not contain the plaintext', () => {
    const f = makeFixtures();
    const text = 'delete /etc/passwd';

    const envelope = encryptCommandPayload(
      text,
      f.contentKeyHex,
      f.keyId,
      f.deviceId,
      f.sessionId,
      f.commandId,
    );

    const decoded = Buffer.from(envelope.sealed_command, 'base64').toString('utf8');
    expect(decoded).not.toContain('delete');
    expect(decoded).not.toContain('/etc/passwd');
  });

  it('AAD binds commandId — swapping commandId fails decrypt', () => {
    const f = makeFixtures();
    const envelope = encryptCommandPayload('secret', f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    expect(() =>
      decryptCommandPayload(envelope.sealed_command, f.contentKeyHex, {
        v: 1, keyId: f.keyId, deviceId: f.deviceId, sessionId: f.sessionId, commandId: 'cmd-other',
      }),
    ).toThrow();
  });

  it('AAD binds deviceId — swapping deviceId fails decrypt', () => {
    const f = makeFixtures();
    const envelope = encryptCommandPayload('secret', f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    expect(() =>
      decryptCommandPayload(envelope.sealed_command, f.contentKeyHex, {
        v: 1, keyId: f.keyId, deviceId: 'device-other', sessionId: f.sessionId, commandId: f.commandId,
      }),
    ).toThrow();
  });

  it('AAD binds sessionId — swapping sessionId fails decrypt', () => {
    const f = makeFixtures();
    const envelope = encryptCommandPayload('secret', f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    expect(() =>
      decryptCommandPayload(envelope.sealed_command, f.contentKeyHex, {
        v: 1, keyId: f.keyId, deviceId: f.deviceId, sessionId: 'session-other', commandId: f.commandId,
      }),
    ).toThrow();
  });

  it('AAD binds keyId — swapping keyId fails decrypt', () => {
    const f = makeFixtures();
    const envelope = encryptCommandPayload('secret', f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    expect(() =>
      decryptCommandPayload(envelope.sealed_command, f.contentKeyHex, {
        v: 1, keyId: 'keyid-other', deviceId: f.deviceId, sessionId: f.sessionId, commandId: f.commandId,
      }),
    ).toThrow();
  });

  it('wrong content key fails decrypt', () => {
    const f = makeFixtures();
    const otherKey = generateContentKey();
    const envelope = encryptCommandPayload('secret', f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    expect(() =>
      decryptCommandPayload(envelope.sealed_command, otherKey.keyHex, {
        v: 1, keyId: f.keyId, deviceId: f.deviceId, sessionId: f.sessionId, commandId: f.commandId,
      }),
    ).toThrow();
  });

  it('single character roundtrips', () => {
    const f = makeFixtures();
    const envelope = encryptCommandPayload('x', f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    const decrypted = decryptCommandPayload(envelope.sealed_command, f.contentKeyHex, {
      v: 1, keyId: f.keyId, deviceId: f.deviceId, sessionId: f.sessionId, commandId: f.commandId,
    });

    expect(decrypted).toBe('x');
  });

  it('long command text roundtrips', () => {
    const f = makeFixtures();
    const text = 'A'.repeat(10_000);

    const envelope = encryptCommandPayload(text, f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    const decrypted = decryptCommandPayload(envelope.sealed_command, f.contentKeyHex, {
      v: 1, keyId: f.keyId, deviceId: f.deviceId, sessionId: f.sessionId, commandId: f.commandId,
    });

    expect(decrypted).toBe(text);
    expect(decrypted.length).toBe(10_000);
  });
});

describe('buildCommandAad', () => {
  it('produces stable utf8 JSON encoding with kind=command discriminator', () => {
    const aad = buildCommandAad({
      v: 1,
      keyId: 'key-11111111-1111-1111-1111-111111111111',
      deviceId: 'dev-22222222-2222-2222-2222-222222222222',
      sessionId: 'ses-33333333-3333-3333-3333-333333333333',
      commandId: 'cmd-44444444-4444-4444-4444-444444444444',
    });

    const decoded = Buffer.from(aad).toString('utf8');
    const parsed = JSON.parse(decoded);
    expect(parsed).toEqual({
      v: 1,
      keyId: 'key-11111111-1111-1111-1111-111111111111',
      deviceId: 'dev-22222222-2222-2222-2222-222222222222',
      sessionId: 'ses-33333333-3333-3333-3333-333333333333',
      eventId: 'cmd-44444444-4444-4444-4444-444444444444',
      eventType: 'command',
    });
  });
});

describe('AAD collision safety', () => {
  it('command AAD with eventType=command cannot be decrypted with eventType=user_prompt AAD', () => {
    const f = makeFixtures();
    const text = 'secret command';
    const envelope = encryptCommandPayload(text, f.contentKeyHex, f.keyId, f.deviceId, f.sessionId, f.commandId);

    // Correct AAD works
    expect(() =>
      decryptCommandPayload(envelope.sealed_command, f.contentKeyHex, {
        v: 1, keyId: f.keyId, deviceId: f.deviceId, sessionId: f.sessionId, commandId: f.commandId,
      }),
    ).not.toThrow();

    // eventType='user_prompt' AAD produces different ciphertext binding
    const key = keyFromHex(f.contentKeyHex);
    const wrongAad = buildAad({
      v: 1,
      keyId: f.keyId,
      deviceId: f.deviceId,
      sessionId: f.sessionId,
      eventId: f.commandId,
      eventType: 'user_prompt',
    });

    expect(() => rawDecrypt(envelope.sealed_command, key, wrongAad)).toThrow();
  });
});
