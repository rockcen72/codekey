import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { checkEnv } from '../config/validate-env.js';

describe('checkEnv — production startup validation', () => {
  // Save and restore all relevant env vars around each test
  const ENV_KEYS = [
    'DATABASE_URL',
    'PUBLIC_BASE_URL',
    'USER_JWT_SECRET',
    'NODE_ENV',
    'WECHAT_APPID',
    'WECHAT_SECRET',
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

  function setValidBase() {
    process.env.DATABASE_URL = 'postgres://codekey:codekey@127.0.0.1:5433/codekey';
    process.env.PUBLIC_BASE_URL = 'https://codekey.tinymoney.cn';
    process.env.USER_JWT_SECRET = 'a'.repeat(48);
  }

  describe('all envs required regardless of NODE_ENV', () => {
    it('rejects missing DATABASE_URL', () => {
      process.env.PUBLIC_BASE_URL = 'https://codekey.tinymoney.cn';
      process.env.USER_JWT_SECRET = 'a'.repeat(48);
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('DATABASE_URL'))).toBe(true);
    });

    it('rejects missing PUBLIC_BASE_URL', () => {
      process.env.DATABASE_URL = 'postgres://x';
      process.env.USER_JWT_SECRET = 'a'.repeat(48);
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('PUBLIC_BASE_URL'))).toBe(true);
    });

    it('rejects missing USER_JWT_SECRET', () => {
      setValidBase();
      delete process.env.USER_JWT_SECRET;
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('USER_JWT_SECRET'))).toBe(true);
    });

    it('rejects USER_JWT_SECRET shorter than 32 chars', () => {
      setValidBase();
      process.env.USER_JWT_SECRET = 'a'.repeat(31);
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('at least 32'))).toBe(true);
    });

    it('accepts USER_JWT_SECRET exactly 32 chars', () => {
      setValidBase();
      process.env.USER_JWT_SECRET = 'a'.repeat(32);
      const r = checkEnv();
      expect(r.ok).toBe(true);
    });

    it('rejects non-http PUBLIC_BASE_URL', () => {
      setValidBase();
      process.env.PUBLIC_BASE_URL = 'ftp://example.com';
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('http or https'))).toBe(true);
    });

    it('normalizes PUBLIC_BASE_URL by stripping path', () => {
      setValidBase();
      process.env.PUBLIC_BASE_URL = 'https://codekey.tinymoney.cn/api/v1/';
      const r = checkEnv();
      expect(r.ok).toBe(true);
      expect(r.env!.PUBLIC_BASE_URL).toBe('https://codekey.tinymoney.cn');
      // And the override is applied to process.env
      expect(process.env.PUBLIC_BASE_URL).toBe('https://codekey.tinymoney.cn');
    });
  });

  describe('NODE_ENV=production — WeChat config required, no mock', () => {
    beforeEach(() => {
      setValidBase();
      process.env.NODE_ENV = 'production';
    });

    it('rejects missing WECHAT_APPID', () => {
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('WECHAT_APPID'))).toBe(true);
    });

    it('rejects WECHAT_APPID=mock', () => {
      process.env.WECHAT_APPID = 'mock';
      process.env.WECHAT_SECRET = 'real_secret_at_least_32_chars_long_xx';
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes("must not be 'mock'"))).toBe(true);
    });

    it('rejects missing WECHAT_SECRET', () => {
      process.env.WECHAT_APPID = 'wx654efb50a7739cf5';
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('WECHAT_SECRET'))).toBe(true);
    });

    it('rejects WECHAT_SECRET=mock', () => {
      process.env.WECHAT_APPID = 'wx654efb50a7739cf5';
      process.env.WECHAT_SECRET = 'mock';
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes("must not be 'mock'"))).toBe(true);
    });

    it('rejects empty WECHAT_SECRET', () => {
      process.env.WECHAT_APPID = 'wx654efb50a7739cf5';
      process.env.WECHAT_SECRET = '';
      const r = checkEnv();
      expect(r.ok).toBe(false);
      expect(r.errors.some(e => e.includes('WECHAT_SECRET'))).toBe(true);
    });

    it('accepts real WeChat credentials', () => {
      process.env.WECHAT_APPID = 'wx654efb50a7739cf5';
      process.env.WECHAT_SECRET = '10dd76c93a4c5fc465fa5e26e93b0408';
      const r = checkEnv();
      expect(r.ok).toBe(true);
      expect(r.errors).toEqual([]);
    });
  });

  describe('NODE_ENV!=production — mock is allowed', () => {
    beforeEach(() => {
      setValidBase();
      // NODE_ENV unset → treated as non-production
    });

    it('accepts WECHAT_APPID=mock when NODE_ENV unset', () => {
      process.env.WECHAT_APPID = 'mock';
      // WECHAT_SECRET not required when mock
      const r = checkEnv();
      expect(r.ok).toBe(true);
    });

    it('accepts WECHAT_APPID=mock when NODE_ENV=development', () => {
      process.env.NODE_ENV = 'development';
      process.env.WECHAT_APPID = 'mock';
      const r = checkEnv();
      expect(r.ok).toBe(true);
    });

    it('accepts WECHAT_APPID=mock when NODE_ENV=test', () => {
      process.env.NODE_ENV = 'test';
      process.env.WECHAT_APPID = 'mock';
      const r = checkEnv();
      expect(r.ok).toBe(true);
    });
  });

  describe('aggregates all errors at once (operator-friendly)', () => {
    it('reports DATABASE_URL + USER_JWT_SECRET + WECHAT_* in single result', () => {
      process.env.NODE_ENV = 'production';
      const r = checkEnv();
      expect(r.ok).toBe(false);
      const joined = r.errors.join('\n');
      expect(joined).toMatch(/DATABASE_URL/);
      expect(joined).toMatch(/PUBLIC_BASE_URL/);
      expect(joined).toMatch(/USER_JWT_SECRET/);
      expect(joined).toMatch(/WECHAT_APPID/);
      expect(joined).toMatch(/WECHAT_SECRET/);
    });
  });
});
