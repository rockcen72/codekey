/**
 * Guard for the dev-only seed routes (/dev/invalidate-entitlement, /dev/usage/...).
 *
 * Default OFF in every environment. Enabling requires all of:
 *
 *   1. DEV_SEED_SECRET              must be set, >= 32 chars (cryptographically strong)
 *   2. DEV_SEED_ENABLED=1           explicit opt-in flag
 *   3. NODE_ENV != 'production'     non-prod environments
 *      OR
 *      ALLOW_DEV_SEED_IN_PRODUCTION=1   explicit production opt-in
 *
 * When any condition fails, `isDevSeedEnabled()` returns false and
 * `devSeedRoutes()` throws at module load — the routes never get a chance to
 * serve a request. The X-Dev-Secret preHandler is the *second* layer: even
 * if somehow the module loads with a weak config, every request must carry
 * the matching header.
 *
 * The 4-condition production opt-in is intentionally separate from the
 * normal triple-guard so that the non-prod default behaviour is unchanged
 * from the original plan, and production exposure requires a clearly
 * visible, removable flag.
 */

const MIN_SECRET_LENGTH = 32;

export interface DevSeedConfig {
  enabled: boolean;
  secret: string | null;
  reason?: string;
}

export function getDevSeedConfig(env: NodeJS.ProcessEnv = process.env): DevSeedConfig {
  const secret = env.DEV_SEED_SECRET ?? null;
  const enabledFlag = env.DEV_SEED_ENABLED === '1';
  const isProduction = (env.NODE_ENV ?? 'development') === 'production';
  const allowInProduction = env.ALLOW_DEV_SEED_IN_PRODUCTION === '1';

  if (!secret) {
    return { enabled: false, secret: null, reason: 'DEV_SEED_SECRET not set' };
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    return {
      enabled: false,
      secret: null,
      reason: `DEV_SEED_SECRET must be at least ${MIN_SECRET_LENGTH} characters (got: ${secret.length})`,
    };
  }
  if (!enabledFlag) {
    return { enabled: false, secret: null, reason: "DEV_SEED_ENABLED must be '1'" };
  }
  if (isProduction && !allowInProduction) {
    return {
      enabled: false,
      secret: null,
      reason: 'NODE_ENV=production and ALLOW_DEV_SEED_IN_PRODUCTION is not set',
    };
  }
  return { enabled: true, secret };
}

export function isDevSeedEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return getDevSeedConfig(env).enabled;
}
