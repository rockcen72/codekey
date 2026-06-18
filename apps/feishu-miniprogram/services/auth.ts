import { getUserToken, getClientToken, getServerUrl } from './storage';

/**
 * Auth service — Phase 1 of the subscription system.
 *
 *   wxLogin()           — exchange tt.login() code for a server-issued user_token
 *   claimDevice()       — bind the current clientToken's device to the logged-in user
 *   ensureUserToken()   — convenience: silently wx-login if no token, then claim the device
 *
 * The two-step (login → claim) lets a logged-in user with no device
 * yet (e.g. opened the mini program before pairing) still own an
 * account, and a paired device without a user (pre-existing devices
 * that haven't migrated) get retroactively bound.
 */

type HttpMethod = 'GET' | 'POST' | 'DELETE';

interface ApiError {
  error: string;
  message?: string;
}

function userRequest<T>(method: HttpMethod, url: string, data?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const token = getUserToken();
    // tt.request 的 header 默认带 'content-type: application/json'。
    // fastify 4.x 在收到 application/json + 空 body 时会返回 400
    // FST_ERR_CTP_EMPTY_JSON_BODY。仅在有 body 时才用 json，否则显式
    // 覆盖为 text/plain（参考 telegram-miniapp/src/api/client.ts）。
    const hasBody = data !== undefined;
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

function publicRequest<T>(method: HttpMethod, url: string, data?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const hasBody = data !== undefined;
    tt.request({
      method,
      url,
      data,
      timeout: 10000,
      header: { 'content-type': hasBody ? 'application/json' : 'text/plain' },
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

export interface WxLoginResult {
  userId: number;
  token: string;
  isNew: boolean;
}

export function wxLogin(code: string, provider: 'wechat' | 'feishu' = 'feishu'): Promise<WxLoginResult> {
  return publicRequest<WxLoginResult>('POST', `${apiBase()}/auth/wx-login`, { code, provider });
}

export interface ClaimDeviceResult {
  success: boolean;
  deviceId: string;
}

export function claimDevice(clientToken?: string): Promise<ClaimDeviceResult> {
  const token = clientToken ?? getClientToken();
  if (!token) return Promise.reject({ error: 'NO_CLIENT_TOKEN' } as ApiError);
  return userRequest<ClaimDeviceResult>('POST', `${apiBase()}/auth/claim-device`, { clientToken: token });
}

/**
 * One-shot: log the user in (if not already) and bind the current
 * device. Safe to call from app.onShow — the second call within
 * one session is essentially free (the second step returns 409
 * 'device already bound' which we swallow).
 */
export async function ensureUserToken(): Promise<{ userId: number; bound: boolean } | null> {
  let token = getUserToken();
  if (!token) {
    const wxCode = await new Promise<string>((resolve, reject) => {
      tt.login({ success: (r) => r.code ? resolve(r.code) : reject(new Error('tt.login failed')), fail: reject });
    });
    const login = await wxLogin(wxCode);
    tt.setStorageSync('CODEKEY_USER_TOKEN', login.token);
    tt.setStorageSync('CODEKEY_USER_ID', login.userId);
    token = login.token;
  }
  try {
    const result = await claimDevice();
    return { userId: (tt.getStorageSync('CODEKEY_USER_ID') as number), bound: true, alreadyBound: !!result?.alreadyBound };
  } catch (err: any) {
    // device is bound to a different user — surface as a structured
    // error so the UI can prompt the user to unbind it on the PC side
    // before re-pairing. Don't swallow this one.
    if (err?.error === 'device bound to another user') {
      const e = new Error('DEVICE_BOUND_TO_ANOTHER_USER') as Error & { code?: string };
      e.code = 'DEVICE_BOUND_TO_ANOTHER_USER';
      throw e;
    }
    // No clientToken yet (user hasn't paired) — log-in still succeeded,
    // device will be claimed after the first successful /devices/confirm.
    if (err?.error === 'NO_CLIENT_TOKEN' || err?.error === 'invalid clientToken') {
      return { userId: (tt.getStorageSync('CODEKEY_USER_ID') as number), bound: false };
    }
    throw err;
  }
}
