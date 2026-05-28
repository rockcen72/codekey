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
