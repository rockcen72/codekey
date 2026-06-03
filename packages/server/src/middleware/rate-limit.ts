/**
 * In-memory rate limiter (per IP, per key prefix).
 *
 * Used as a defensive layer in front of unauthenticated or low-cost endpoints
 * to prevent abuse. The bridge → server traffic from a single PC is far below
 * the default global limit, and the mini program polling cadence is also well
 * within the bucket — so legitimate traffic should never hit 429.
 *
 * For multi-instance deployments switch to a Redis-backed limiter; this is a
 * single-process bucket and resets on server restart.
 *
 * Escape hatch: set RATE_LIMIT_DISABLED=1 to bypass all limits (use only when
 * actively debugging — disables the abuse defence).
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

// Periodic cleanup: prevent unbounded growth from one-off attackers.
const CLEANUP_INTERVAL_MS = 60_000;
setInterval(() => {
  const now = Date.now();
  for (const [key, b] of buckets) {
    if (b.resetAt < now) buckets.delete(key);
  }
}, CLEANUP_INTERVAL_MS).unref?.();

export interface RateLimitOptions {
  /** Window length in milliseconds. */
  windowMs: number;
  /** Maximum requests per IP per window. */
  max: number;
  /** Bucket key prefix — keep different endpoints in different buckets. */
  keyPrefix: string;
}

export function rateLimit(opts: RateLimitOptions) {
  return async function (req: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (process.env.RATE_LIMIT_DISABLED === '1') return;

    const ip = req.ip || 'unknown';
    const key = `${opts.keyPrefix}:${ip}`;
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || b.resetAt < now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(key, b);
    }
    b.count += 1;
    if (b.count > opts.max) {
      const retryAfterSec = Math.ceil((b.resetAt - now) / 1000);
      reply.header('Retry-After', String(retryAfterSec));
      reply.code(429).send({ error: 'RATE_LIMITED', retryAfter: retryAfterSec });
    }
  };
}
