import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Compact JWT (HS256) implementation using only Node built-ins.
 * Avoids pulling in `jsonwebtoken` / `jose` for what is essentially
 * three base64url segments + an HMAC.
 *
 * Claims layout (kept minimal — auth middleware only reads `sub`
 * and `exp`):
 *   sub:   user id as string
 *   iat:   issued-at (seconds)
 *   exp:   expires-at (seconds)
 */

export interface UserJwtClaims {
  sub: string;
  iat: number;
  exp: number;
}

const HEADER = base64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));

function getSecret(): string {
  const s = process.env.USER_JWT_SECRET;
  if (!s) {
    throw new Error('USER_JWT_SECRET is not set; refusing to sign user tokens');
  }
  if (s.length < 32) {
    throw new Error('USER_JWT_SECRET must be at least 32 characters');
  }
  return s;
}

export function signUserJwt(userId: number | string, ttlSeconds = 60 * 60 * 24 * 30): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: UserJwtClaims = {
    sub: String(userId),
    iat: now,
    exp: now + ttlSeconds,
  };
  const payload = base64urlEncode(JSON.stringify(claims));
  const signingInput = `${HEADER}.${payload}`;
  const sig = base64urlEncode(hmacSha256(signingInput, getSecret()));
  return `${signingInput}.${sig}`;
}

export type VerifyResult =
  | { ok: true; claims: UserJwtClaims }
  | { ok: false; reason: 'malformed' | 'bad_signature' | 'expired' };

export function verifyUserJwt(token: string): VerifyResult {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, sig] = parts;
  const expected = base64urlEncode(hmacSha256(`${header}.${payload}`, getSecret()));
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: 'bad_signature' };
  }
  let claims: UserJwtClaims;
  try {
    claims = JSON.parse(base64urlDecode(payload));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number') {
    return { ok: false, reason: 'malformed' };
  }
  if (claims.exp <= Math.floor(Date.now() / 1000)) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, claims };
}

// ── helpers ─────────────────────────────────────────────────

function hmacSha256(input: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(input).digest();
}

function base64urlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlDecode(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}
