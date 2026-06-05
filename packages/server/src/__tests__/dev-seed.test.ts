import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDevSeedConfig, isDevSeedEnabled } from '../config/dev-seed.js';

const ENV_KEYS = [
  'DEV_SEED_SECRET',
  'DEV_SEED_ENABLED',
  'NODE_ENV',
  'ALLOW_DEV_SEED_IN_PRODUCTION',
] as const;
const ORIGINAL: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) {
    ORIGINAL[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (ORIGINAL[k] === undefined) delete process.env[k];
    else process.env[k] = ORIGINAL[k];
  }
});

const STRONG_SECRET = 'a'.repeat(48);

describe('isDevSeedEnabled — 4-condition guard', () => {
  describe('non-production (NODE_ENV=development / unset)', () => {
    it('disabled: missing secret', () => {
      expect(isDevSeedEnabled()).toBe(false);
      expect(getDevSeedConfig().reason).toMatch(/DEV_SEED_SECRET not set/);
    });

    it('disabled: secret too short', () => {
      process.env.DEV_SEED_SECRET = 'a'.repeat(31);
      process.env.DEV_SEED_ENABLED = '1';
      expect(isDevSeedEnabled()).toBe(false);
      expect(getDevSeedConfig().reason).toMatch(/at least 32 characters/);
    });

    it('disabled: missing DEV_SEED_ENABLED', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      expect(isDevSeedEnabled()).toBe(false);
      expect(getDevSeedConfig().reason).toMatch(/DEV_SEED_ENABLED/);
    });

    it('disabled: DEV_SEED_ENABLED=0 even with everything else set', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '0';
      expect(isDevSeedEnabled()).toBe(false);
    });

    it('enabled: secret + enabled, NODE_ENV unset (treated as non-prod)', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '1';
      expect(isDevSeedEnabled()).toBe(true);
    });

    it('enabled: secret + enabled, NODE_ENV=development', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '1';
      process.env.NODE_ENV = 'development';
      expect(isDevSeedEnabled()).toBe(true);
    });

    it('enabled: secret + enabled, NODE_ENV=test', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '1';
      process.env.NODE_ENV = 'test';
      expect(isDevSeedEnabled()).toBe(true);
    });
  });

  describe('production (NODE_ENV=production) — requires explicit opt-in', () => {
    beforeEach(() => {
      process.env.NODE_ENV = 'production';
    });

    it('disabled: secret + enabled, but no ALLOW flag', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '1';
      expect(isDevSeedEnabled()).toBe(false);
      expect(getDevSeedConfig().reason).toMatch(/ALLOW_DEV_SEED_IN_PRODUCTION/);
    });

    it('disabled: ALLOW_DEV_SEED_IN_PRODUCTION=0 (only "1" is truthy)', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '1';
      process.env.ALLOW_DEV_SEED_IN_PRODUCTION = '0';
      expect(isDevSeedEnabled()).toBe(false);
    });

    it('disabled: ALLOW=true but no secret', () => {
      process.env.DEV_SEED_ENABLED = '1';
      process.env.ALLOW_DEV_SEED_IN_PRODUCTION = '1';
      expect(isDevSeedEnabled()).toBe(false);
    });

    it('enabled: secret + enabled + ALLOW=1', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '1';
      process.env.ALLOW_DEV_SEED_IN_PRODUCTION = '1';
      expect(isDevSeedEnabled()).toBe(true);
    });
  });

  describe('returned config surfaces reason when disabled (operator-friendly)', () => {
    it('returns null secret + reason when disabled', () => {
      const c = getDevSeedConfig();
      expect(c.enabled).toBe(false);
      expect(c.secret).toBeNull();
      expect(c.reason).toBeDefined();
    });

    it('returns the secret when enabled (caller uses it for X-Dev-Secret check)', () => {
      process.env.DEV_SEED_SECRET = STRONG_SECRET;
      process.env.DEV_SEED_ENABLED = '1';
      const c = getDevSeedConfig();
      expect(c.enabled).toBe(true);
      expect(c.secret).toBe(STRONG_SECRET);
      expect(c.reason).toBeUndefined();
    });
  });
});
