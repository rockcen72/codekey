// Subscription service �?mini program side.
// All calls require user_token (Bearer auth). The companion endpoints
// live in packages/server/src/routes/subscription.ts.
//
// The mini program uses the same ensureUserToken() flow from auth.ts
// to obtain a user_token before invoking these; settings.ts and
// any future paywall UI are expected to gate on `getUserToken()`.

import { getUserToken, getServerUrl } from './storage';

type HttpMethod = 'GET' | 'POST';

interface ApiError {
  error: string;
  message?: string;
}

function userRequest<T>(method: HttpMethod, url: string, data?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const token = getUserToken();
    // tt.request �?header 默认�?'content-type: application/json'�?    // fastify 4.x 在收�?application/json + �?body 时会返回 400
    // FST_ERR_CTP_EMPTY_JSON_BODY。仅在有 body 时才�?json，否则显�?    // 覆盖�?text/plain（参�?telegram-miniapp/src/api/client.ts）�?    const hasBody = data !== undefined;
    tt.request({
      method,
      url,
      data,
      timeout: 10000,
      header: {
        'content-type': hasBody ? 'application/json' : 'text/plain',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      success(res: any) {
        if (res.statusCode >= 400) {
          reject(res.data as ApiError);
          return;
        }
        resolve(res.data as T);
      },
      fail(err: any) {
        reject({ error: 'NETWORK_ERROR', message: err.errMsg } as ApiError);
      },
    });
  });
}

function apiBase(): string {
  const base = getServerUrl();
  return base.endsWith('/api/v1') ? base : `${base}/api/v1`;
}

export type Tier = 'paid' | 'trial' | 'free';

/** Per-month usage counter for the approval quota. Returned only for
 *  free-tier users by GET /subscription; paid / trial get `null`. */
export interface UsageSnapshot {
  used: number;
  limit: number;
  /** "YYYY-MM" in UTC, matches the period used for the counter. */
  period: string;
}

export interface SubscriptionStatus {
  tier: Tier;
  plan: string | null;
  expiresAt: string | null; // ISO timestamp or null
  product: string;
  usage: UsageSnapshot | null;
}

export interface RedeemOk {
  success: true;
  product: string;
  plan: string;
  durationDays: number;
  beforeExpiresAt: string | null;
  afterExpiresAt: string;
}

export type RedeemErrorKind =
  | 'invalid_format'
  | 'not_found'
  | 'already_used'
  | 'void'
  | 'product_mismatch'
  | 'NETWORK_ERROR'
  | 'NO_USER_TOKEN';

export function getSubscription(): Promise<SubscriptionStatus> {
  return userRequest<SubscriptionStatus>('GET', `${apiBase()}/subscription`);
}

export async function redeemCode(code: string): Promise<RedeemOk> {
  // Normalize: strip whitespace, uppercase. Match server-side regex.
  const normalized = code.trim().toUpperCase();
  const result = await userRequest<RedeemOk>('POST', `${apiBase()}/redeem`, { code: normalized });
  return result;
}
