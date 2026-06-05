import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { signUserJwt, verifyUserJwt } from '../auth/jwt.js';

describe('user JWT (HS256, no external deps)', () => {
  const ORIGINAL_SECRET = process.env.USER_JWT_SECRET;

  beforeAll(() => {
    process.env.USER_JWT_SECRET = 'a'.repeat(48);
  });

  afterAll(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.USER_JWT_SECRET;
    else process.env.USER_JWT_SECRET = ORIGINAL_SECRET;
  });

  it('signs and verifies a valid token roundtrip', () => {
    const token = signUserJwt(42);
    const result = verifyUserJwt(token);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.claims.sub).toBe('42');
      expect(result.claims.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
    }
  });

  it('rejects a token signed with a different secret', () => {
    const token = signUserJwt(7);
    process.env.USER_JWT_SECRET = 'b'.repeat(48);
    const result = verifyUserJwt(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('bad_signature');
    process.env.USER_JWT_SECRET = 'a'.repeat(48);
  });

  it('rejects a malformed token (wrong number of segments)', () => {
    const result = verifyUserJwt('a.b');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('malformed');
  });

  it('rejects a token with tampered payload', () => {
    const token = signUserJwt(1);
    const [h, _p, s] = token.split('.');
    const result = verifyUserJwt(`${h}.${_p}AAAA.${s}`);
    expect(result.ok).toBe(false);
  });

  it('rejects an expired token', () => {
    const token = signUserJwt(1, -10);
    const result = verifyUserJwt(token);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('expired');
  });

  it('throws when USER_JWT_SECRET is missing', () => {
    delete process.env.USER_JWT_SECRET;
    expect(() => signUserJwt(1)).toThrow(/USER_JWT_SECRET/);
    process.env.USER_JWT_SECRET = 'a'.repeat(48);
  });

  it('throws when USER_JWT_SECRET is too short', () => {
    process.env.USER_JWT_SECRET = 'short';
    expect(() => signUserJwt(1)).toThrow(/at least 32/);
    process.env.USER_JWT_SECRET = 'a'.repeat(48);
  });
});
