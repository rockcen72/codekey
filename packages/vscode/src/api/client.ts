import type { Credentials } from '../auth/credentials.js';
import { secureFetch } from '../util/secure-fetch.js';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface SessionResponse {
  id: string;
  device_id: string;
  agent_type: string;
  status: string;
  metadata: Record<string, string>;
  created_at: string;
  last_active_at: string;
}

export interface EventResponse {
  id: string;
  session_id: string;
  type: string;
  data: any;
  risk_level: string | null;
  pending: boolean;
  decision: string | null;
  created_at: string;
}

export function createApi(creds: Credentials) {
  const base = `${creds.relayUrl}/api/v1`;

  async function request<T>(method: string, path: string, body?: any): Promise<T> {
    const signal = AbortSignal.timeout(3000);
    const res = await secureFetch(`${base}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(creds.deviceToken ? { Authorization: `Bearer ${creds.deviceToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    if (!res.ok) throw new ApiError(res.status, `API error ${res.status}: ${await res.text()}`);
    return res.json() as Promise<T>;
  }

  return {
    getSessions(windowId?: string): Promise<SessionResponse[]> {
      const path = windowId ? `/sessions?windowId=${encodeURIComponent(windowId)}` : '/sessions';
      return request<SessionResponse[]>('GET', path);
    },

    getSessionEvents(sessionId: string): Promise<EventResponse[]> {
      return request<EventResponse[]>('GET', `/sessions/${sessionId}/events`);
    },

    getDeviceSubscription(): Promise<SubscriptionResponse> {
      return request<SubscriptionResponse>('GET', '/device-subscription');
    },
  };
}

export interface SubscriptionResponse {
  tier: 'free' | 'trial' | 'paid';
  plan: string | null;
  expiresAt: string | null;
  product: string;
  usage: { used: number; limit: number; period: string } | null;
}

export type ApiClient = ReturnType<typeof createApi>;
