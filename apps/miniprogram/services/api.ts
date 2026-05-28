import { getClientToken, clearAuth } from './storage';

type HttpMethod = 'GET' | 'POST' | 'DELETE';

interface ApiError {
  error: string;
  message?: string;
}

function request<T>(method: HttpMethod, url: string, data?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const token = getClientToken();
    wx.request({
      method,
      url,
      data,
      header: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      success(res: any) {
        if (res.statusCode === 401) {
          clearAuth();
          wx.redirectTo({ url: '/pages/login/login' });
          reject(new Error('unauthorized'));
          return;
        }
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

export interface Session {
  id: string;
  device_id: string;
  agent_type: string;
  status: string;
  pending_count?: number;
  metadata?: {
    claudeSessionId?: string;
    runtime?: string;
    title?: string;
    cwd?: string;
    source?: string;
    windowId?: string;
  };
  created_at: string;
  last_active_at: string;
}

export interface EventRecord {
  id: string;
  session_id: string;
  type: string;
  data: any;
  risk_level: string | null;
  pending: boolean;
  decision: string | null;
  created_at: string;
}

export interface ConfirmResult {
  clientToken: string;
  deviceId: string;
}

export function createApi(serverUrl: string) {
  const api = serverUrl.endsWith('/api/v1') ? serverUrl : `${serverUrl}/api/v1`;

  return {
    confirmCode(code: string): Promise<ConfirmResult> {
      return request<ConfirmResult>('POST', `${api}/devices/confirm`, { code });
    },

    getSessions(): Promise<Session[]> {
      return request<Session[]>('GET', `${api}/sessions`);
    },

    getSession(id: string): Promise<Session> {
      return request<Session>('GET', `${api}/sessions/${id}`);
    },

    getSessionEvents(id: string): Promise<EventRecord[]> {
      return request<EventRecord[]>('GET', `${api}/sessions/${id}/events`);
    },

    getDevices(): Promise<any[]> {
      return request<any[]>('GET', `${api}/devices`);
    },

    unbindDevice(id: string): Promise<void> {
      return request<void>('DELETE', `${api}/devices/${id}`);
    },
  };
}

export type ApiClient = ReturnType<typeof createApi>;
