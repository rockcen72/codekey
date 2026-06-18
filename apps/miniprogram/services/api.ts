import { getClientToken, clearAuth } from './storage';

type HttpMethod = 'GET' | 'POST' | 'DELETE' | 'PATCH';

interface ApiError {
  error: string;
  message?: string;
}

function request<T>(method: HttpMethod, url: string, data?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const token = getClientToken();
    // wx.request 的 header 默认带 'content-type: application/json'。
    // 当请求没有 body（DELETE / GET）时，fastify 4.x 会以
    // FST_ERR_CTP_EMPTY_JSON_BODY 返回 400。所以仅在显式有 data 时
    // 才使用 application/json，没有 body 时显式覆盖为 text/plain。
    // 与 apps/telegram-miniapp/src/api/client.ts 的策略一致。
    const hasBody = data !== undefined;
    wx.request({
      method,
      url,
      data,
      timeout: 5000,
      header: {
        'content-type': hasBody ? 'application/json' : 'text/plain',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      success(res: any) {
        if (res.statusCode === 401) {
          clearAuth();
          wx.reLaunch({ url: '/pages/sessions/sessions' });
          // Resolve with empty data to prevent caller error loops
          resolve([] as any);
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
  desktopNotified?: boolean;
  e2eAvailable?: boolean;
  desktopPublicKeyHex?: string;
  e2eKeyReceived?: boolean;
}

export function createApi(serverUrl: string) {
  const api = serverUrl.endsWith('/api/v1') ? serverUrl : `${serverUrl}/api/v1`;

  return {
    confirmCode(code: string, platform: 'wechat' | 'feishu' = 'wechat', phonePublicKeyHex?: string): Promise<ConfirmResult> {
      return request<ConfirmResult>('POST', `${api}/devices/confirm`, {
        code,
        platform,
        ...(phonePublicKeyHex ? { phonePublicKeyHex } : {}),
      });
    },

    getSessions(): Promise<Session[]> {
      return request<Session[]>('GET', `${api}/sessions?history=1`);
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

    hideSession(sessionId: string): Promise<void> {
      return request<void>('PATCH', `${api}/sessions/${sessionId}/hide`);
    },
  };
}

export type ApiClient = ReturnType<typeof createApi>;
