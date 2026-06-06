import { clearUserToken, getUserToken } from '../auth/storage';

export const AUTH_EXPIRED_EVENT = 'codekey:auth-expired';

const API_BASE = import.meta.env.VITE_TELEGRAM_WORKER_URL || '';

async function request<T>(path: string, init: RequestInit = {}, token?: string | null): Promise<T> {
  const headers = new Headers(init.headers);
  if (!headers.has('content-type') && init.body) {
    headers.set('content-type', 'application/json');
  }
  if (token) {
    headers.set('authorization', `Bearer ${token}`);
  }

  const resp = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers,
    signal: AbortSignal.timeout(15_000),
  });
  if (resp.status === 401) {
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
