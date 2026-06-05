/**
 * Production-critical environment validation.
 *
 * Called at startup by both src/index.ts (dev / tsx) and src/bundle-entry.ts
 * (production relay.cjs bundle). Centralising the check prevents drift between
 * the two entry points — historically bundle-entry.ts lagged behind index.ts
 * and missed the USER_JWT_SECRET check, which let the production process
 * start successfully even with JWT signing completely broken.
 *
 * On any failure, prints all collected errors to stderr (so the operator can
 * fix everything in one go) and exits the process with code 1. Never throws —
 * a misconfigured server must hard-exit, not limp into a half-working state
 * where /health returns 200 but /wx-login returns 503.
 */

export interface ValidatedEnv {
  DATABASE_URL: string;
  PUBLIC_BASE_URL: string;
}

export interface EnvCheckResult {
  ok: boolean;
  errors: string[];
  env?: ValidatedEnv;
}

const MIN_JWT_SECRET_LENGTH = 32;

export function checkEnv(): EnvCheckResult {
  const errors: string[] = [];

  const DATABASE_URL = process.env.DATABASE_URL;
  if (!DATABASE_URL) {
    errors.push('DATABASE_URL is required (e.g. postgres://user:pass@host:5432/db)');
  }

  const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;
  let normalizedBaseUrl: string | undefined;
  if (!PUBLIC_BASE_URL) {
    errors.push('PUBLIC_BASE_URL is required (e.g. https://codekey.tinymoney.cn)');
  } else {
    try {
      const parsed = new URL(PUBLIC_BASE_URL);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        errors.push(
          `PUBLIC_BASE_URL must use http or https (got: ${parsed.protocol})`,
        );
      } else {
        normalizedBaseUrl = `${parsed.protocol}//${parsed.host}`;
      }
    } catch {
      errors.push(`PUBLIC_BASE_URL is not a valid URL: ${PUBLIC_BASE_URL}`);
    }
  }

  const USER_JWT_SECRET = process.env.USER_JWT_SECRET;
  if (!USER_JWT_SECRET) {
    errors.push(
      'USER_JWT_SECRET is required (at least 32 characters). Generate with: openssl rand -hex 32',
    );
  } else if (USER_JWT_SECRET.length < MIN_JWT_SECRET_LENGTH) {
    errors.push(
      `USER_JWT_SECRET must be at least ${MIN_JWT_SECRET_LENGTH} characters (got: ${USER_JWT_SECRET.length})`,
    );
  }

  const NODE_ENV = process.env.NODE_ENV ?? 'development';
  const isProduction = NODE_ENV === 'production';
  const WECHAT_APPID = process.env.WECHAT_APPID;
  const WECHAT_SECRET = process.env.WECHAT_SECRET;

  if (isProduction) {
    if (!WECHAT_APPID) {
      errors.push(
        'WECHAT_APPID is required in production (got: empty). Get it from https://mp.weixin.qq.com → 开发管理 → 开发设置',
      );
    } else if (WECHAT_APPID === 'mock') {
      errors.push(
        `WECHAT_APPID must not be 'mock' in production (NODE_ENV=production). Get the real value from https://mp.weixin.qq.com → 开发管理 → 开发设置`,
      );
    }
    if (!WECHAT_SECRET) {
      errors.push(
        'WECHAT_SECRET is required in production (got: empty). Get it from https://mp.weixin.qq.com → 开发管理 → 开发设置',
      );
    } else if (WECHAT_SECRET === 'mock') {
      errors.push(
        `WECHAT_SECRET must not be 'mock' in production (NODE_ENV=production). Get the real value from https://mp.weixin.qq.com → 开发管理 → 开发设置`,
      );
    }
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  // Override env so the rest of the app uses the normalized value.
  process.env.PUBLIC_BASE_URL = normalizedBaseUrl;

  return {
    ok: true,
    errors: [],
    env: { DATABASE_URL: DATABASE_URL!, PUBLIC_BASE_URL: normalizedBaseUrl! },
  };
}

export function validateEnv(): ValidatedEnv {
  const result = checkEnv();
  if (!result.ok) {
    console.error('FATAL: Invalid or missing environment configuration:');
    for (const e of result.errors) {
      console.error(`  - ${e}`);
    }
    process.exit(1);
  }
  return result.env!;
}
