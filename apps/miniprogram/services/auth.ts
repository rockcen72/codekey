import { getUserToken, getClientToken, getServerUrl } from './storage';

/**
 * Auth service — Phase 1 of the subscription system.
 *
 *   wxLogin()           — exchange wx.login() code for a server-issued user_token
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
    wx.request({
      method,
      url,
      data,
      header: {
        'Content-Type': 'application/json',
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
    wx.request({
      method,
      url,
      data,
      header: { 'Content-Type': 'application/json' },
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

export function wxLogin(code: string, provider: 'wechat' | 'feishu' = 'wechat'): Promise<WxLoginResult> {
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
      wx.login({ success: (r) => r.code ? resolve(r.code) : reject(new Error('wx.login failed')), fail: reject });
    });
    const login = await wxLogin(wxCode);
    wx.setStorageSync('CODEKEY_USER_TOKEN', login.token);
    wx.setStorageSync('CODEKEY_USER_ID', login.userId);
    token = login.token;
  }
  try {
    await claimDevice();
    return { userId: (wx.getStorageSync('CODEKEY_USER_ID') as number), bound: true };
  } catch (err: any) {
    if (err?.error === 'device already bound') {
      return { userId: (wx.getStorageSync('CODEKEY_USER_ID') as number), bound: true };
    }
    // No clientToken yet (user hasn't paired) — log-in still succeeded,
    // device will be claimed after the first successful /devices/confirm.
    if (err?.error === 'NO_CLIENT_TOKEN' || err?.error === 'invalid clientToken') {
      return { userId: (wx.getStorageSync('CODEKEY_USER_ID') as number), bound: false };
    }
    throw err;
  }
}
