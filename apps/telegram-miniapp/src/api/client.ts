import { clearUserToken, getUserToken } from '../auth/storage';
import { clearDeviceCredentials, getClientToken } from '../auth/device-storage';

export const AUTH_EXPIRED_EVENT = 'codekey:auth-expired';
export const CLIENT_TOKEN_INVALID_EVENT = 'codekey:client-token-invalid';

/**
 * Thrown by request() when the server reports the caller's Telegram
 * session has no active device binding. This is an expected state
 * (user logged in but never paired, or another platform took over the
 * device) — UI hooks should silently fall back to an empty/unbound
 * view instead of surfacing a noisy error message. The 5s polling
 * loops in useDevices/useSessions/useSubscription would otherwise
 * spam the screen with `client_token_required` toasts every tick.
 */
export class UnboundDeviceError extends Error {
  readonly code: 'client_token_required' | 'client_token_invalid';
  constructor(code: 'client_token_required' | 'client_token_invalid') {
    super(code);
    this.name = 'UnboundDeviceError';
    this.code = code;
  }
}

const API_BASE = import.meta.env.VITE_TELEGRAM_WORKER_URL || '';

async function request<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }
  // Tag every authenticated user-token request with the per-platform
  // clientToken so the server can verify the caller is the active
  // mobile platform for the device. Without this, a stale Telegram
  // login that resolves to a user_id with an active WeChat binding
  // would still see WeChat's sessions/events.
  if (token) {
    const clientToken = getClientToken();
    if (clientToken) {
      headers.set('x-codekey-client-token', clientToken);
    }
  }

  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 401) {
    let body: { error?: string } = {};
    try { body = await resp.clone().json() as { error?: string }; } catch { /* not JSON */ }
    // 'client_token_required' (no header sent) and 'client_token_invalid'
    // (header sent but no longer the active platform's token) both mean
    // "this Telegram session is not bound to any device on the server".
    // Drop only device credentials, keep user_token so the UI can show
    // an unbound state rather than bouncing to /login. Surface as a
    // typed error so hooks/pages can ignore it (the unbound state is
    // already conveyed by auth.deviceId === null).
    if (body.error === 'client_token_invalid' || body.error === 'client_token_required') {
      clearDeviceCredentials();
      window.dispatchEvent(new Event(CLIENT_TOKEN_INVALID_EVENT));
      throw new UnboundDeviceError(body.error);
    }
    clearUserToken();
    window.dispatchEvent(new Event(AUTH_EXPIRED_EVENT));
  }
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const body = (await resp.json()) as { error?: string };
      message = body.error || message;
    } catch {
      // Keep the status message when the response is not JSON.
    }
    throw new Error(message);
  }
  return (await resp.json()) as T;
}

export function userRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init, getUserToken());
}

export function publicRequest<T>(path: string, init?: RequestInit): Promise<T> {
  return request<T>(path, init, null);
}
