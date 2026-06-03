import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Unit tests for loadCredentials. We mock os.homedir and fs to avoid
 * touching the real credentials file.
 */

const FIXTURE_DIR = '/tmp/codekey-test';
// CREDENTIALS_PATH from @codekey/shared/constants.ts is '.codekey/credentials.json'
const FAKE_CREDS = path.join(FIXTURE_DIR, '.codekey', 'credentials.json');

vi.mock('node:os', () => ({
  homedir: () => FIXTURE_DIR,
}));

const { loadCredentials, saveCredentials, clearCredentials } = await import('../auth/credentials.js');

describe('B2-8 loadCredentials', () => {
  beforeEach(() => {
    fs.mkdirSync(path.dirname(FAKE_CREDS), { recursive: true });
  });
  afterEach(() => {
    try { fs.unlinkSync(FAKE_CREDS); } catch {}
  });

  it('returns null when file is missing', () => {
    clearCredentials();
    expect(loadCredentials()).toBeNull();
  });

  it('returns null when JSON is malformed', () => {
    fs.writeFileSync(FAKE_CREDS, '{not valid json');
    expect(loadCredentials()).toBeNull();
  });

  it('returns null when deviceId is missing', () => {
    fs.writeFileSync(FAKE_CREDS, JSON.stringify({ deviceSecret: 'x' }));
    expect(loadCredentials()).toBeNull();
  });

  it('returns null when deviceSecret is missing', () => {
    fs.writeFileSync(FAKE_CREDS, JSON.stringify({ deviceId: 'x' }));
    expect(loadCredentials()).toBeNull();
  });

  it('returns credentials with empty relayUrl when not stored', () => {
    saveCredentials({ deviceId: 'd-1', deviceSecret: 's-1', relayUrl: '' });
    const c = loadCredentials();
    expect(c?.deviceId).toBe('d-1');
    expect(c?.deviceSecret).toBe('s-1');
    expect(c?.relayUrl).toBe('');
    expect(c?.deviceToken).toBeUndefined();
  });

  it('preserves all fields when fully populated', () => {
    saveCredentials({
      deviceId: 'd-1',
      deviceSecret: 's-1',
      deviceToken: 't-1',
      relayUrl: 'https://example.com',
    });
    const c = loadCredentials();
    expect(c).toEqual({
      deviceId: 'd-1',
      deviceSecret: 's-1',
      deviceToken: 't-1',
      relayUrl: 'https://example.com',
    });
  });

  it('strips non-string deviceToken from raw file', () => {
    // Simulates a tampered or older credentials file that has a non-string
    // deviceToken. loadCredentials must coerce to undefined to keep types
    // honest.
    fs.writeFileSync(
      FAKE_CREDS,
      JSON.stringify({ deviceId: 'd', deviceSecret: 's', deviceToken: 12345 }),
    );
    const c = loadCredentials();
    expect(c?.deviceToken).toBeUndefined();
  });

  it('preserves string deviceToken', () => {
    saveCredentials({ deviceId: 'd', deviceSecret: 's', deviceToken: 't', relayUrl: '' });
    expect(loadCredentials()?.deviceToken).toBe('t');
  });
});
