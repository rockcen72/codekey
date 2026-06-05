import { WsClient } from './services/ws';
import { getClientToken, getDeviceId, getServerUrl, clearAuth } from './services/storage';

type EventHandler = (payload?: any) => void;

App({
  globalData: {
    serverUrl: getServerUrl(),
    clientToken: getClientToken() || '',
    deviceId: getDeviceId() || '',
    ws: null as WsClient | null,
    wsConnected: false,
  },

  onLaunch() {
    this.initWs();
  },

  onShow() {
    // Reconnect WS if it was killed while in background
    if (!this.globalData.wsConnected && getClientToken()) {
      if (this.globalData.ws) {
        this.globalData.ws.disconnect();
        this.globalData.ws = null;
      }
      this.initWs();
    }
  },

  // ── WS lifecycle ──

  initWs() {
    const token = getClientToken();
    const deviceId = getDeviceId();
    if (!token || !deviceId) return;

    this.globalData.serverUrl = getServerUrl();
    this.globalData.clientToken = token;
    this.globalData.deviceId = deviceId;

    // Don't re-create if already running
    if (this.globalData.ws) return;

    const ws = new WsClient(getServerUrl(), deviceId, token);

    ws.on('connected', () => {
      this.globalData.wsConnected = true;
      this._emit('ws_connected');
    });
    ws.on('disconnected', () => {
      this.globalData.wsConnected = false;
      this._emit('ws_disconnected');
    });
    ws.on('auth_failed', () => {
      clearAuth();
      this.globalData.ws = null;
      this.globalData.wsConnected = false;
      wx.redirectTo({ url: '/pages/login/login' });
    });
    ws.on('*', (msg: any) => {
      this._emit(msg.type, msg.payload ?? msg);
    });
    // Phase 3: when the server blocks an approval because the free
    // monthly cap is hit, surface a toast. The actual event row was
    // still written server-side for audit; we just don't push the
    // event_push the phone would have answered.
    ws.on('quota_exceeded', (payload: any) => {
      const used = payload?.used ?? 0;
      const limit = payload?.limit ?? 50;
      wx.showToast({
        title: `本月审批已用完 (${used}/${limit})，升级 Pro 解锁无限`,
        icon: 'none',
        duration: 3000,
      });
    });

    ws.connect();
    this.globalData.ws = ws;
  },

  destroyWs() {
    const ws = this.globalData.ws;
    if (ws) {
      ws.disconnect();
      this.globalData.ws = null;
      this.globalData.wsConnected = false;
    }
    this._eventBus.clear();
  },

  // ── Typed event bus ──

  _eventBus: new Map<string, Set<EventHandler>>(),

  _emit(event: string, payload?: any) {
    const handlers = this._eventBus.get(event);
    if (handlers) handlers.forEach((fn) => fn(payload));
  },

  onWsEvent(event: string, handler: EventHandler) {
    if (!this._eventBus.has(event)) this._eventBus.set(event, new Set());
    this._eventBus.get(event)!.add(handler);
  },

  offWsEvent(event: string, handler: EventHandler) {
    this._eventBus.get(event)?.delete(handler);
  },

  sendWs(msg: object) {
    this.globalData.ws?.send(msg);
  },
});
