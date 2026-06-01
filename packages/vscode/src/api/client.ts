import type { Credentials } from '../auth/credentials.js';

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
    const signal = AbortSignal.timeout(5000);
    const res = await fetch(`${base}${path}`, {
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
  };
}

export type ApiClient = ReturnType<typeof createApi>;
