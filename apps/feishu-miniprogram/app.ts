import { WsClient } from './services/ws';
import { getClientToken, getDeviceId, getServerUrl, clearAuth } from './services/storage';

type EventHandler = (payload?: any) => void;

// Module-local throttle timestamp for the quota_exceeded toast. Reset
// on every initWs() via the let-binding below �?see QUOTA_TOAST_SUPPRESS_MS.
let lastQuotaToastAt = 0;
const QUOTA_TOAST_SUPPRESS_MS = 5_000;
// Guard against auth_failed firing twice (once from onMessage, once from onClose with code 4001)
let _deviceReplaced = false;

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
    _deviceReplaced = false;
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
    ws.on('auth_failed', (payload?: { code?: string }) => {
      const code = payload?.code || 'DEVICE_UNBOUND';
      if (code === 'DEVICE_REPLACED') {
        if (_deviceReplaced) return;
        _deviceReplaced = true;
        tt.showModal({
          title: '设备已替�?,
          content: '账号已绑定新主机，当前设备已自动解绑，请重新配对�?,
          showCancel: false,
          success: () => {
            clearAuth();
            this.globalData.ws = null;
            this.globalData.wsConnected = false;
            this._emit('paired_state_changed');
            tt.reLaunch({ url: '/pages/sessions/sessions' });
          },
        });
        return;
      }
      clearAuth();
      this.globalData.ws = null;
      this.globalData.wsConnected = false;
      this._emit('paired_state_changed');
      tt.reLaunch({ url: '/pages/sessions/sessions' });
    });
    ws.on('*', (msg: any) => {
      this._emit(msg.type, msg.payload ?? msg);
    });
    // Phase 3: when the server blocks an approval because the free
    // monthly cap is hit, surface a toast. The actual event row was
    // still written server-side for audit; we just don't push the
    // event_push the phone would have answered.
    //
    // tt.showToast is queue-then-display: a burst of over-limit events
    // (e.g. several input_required prompts that all blow past 50/50)
    // would chain toasts, with the last one showing ~6s after the
    // first. Suppress repeat toasts within QUOTA_TOAST_SUPPRESS_MS �?
    // the per-event log via tt.showToast won't be missed when the
    // user is already aware of the cap.
    ws.on('quota_exceeded', (payload: any) => {
      const now = Date.now();
      if (now - lastQuotaToastAt < QUOTA_TOAST_SUPPRESS_MS) return;
      lastQuotaToastAt = now;
      const used = payload?.used ?? 0;
      const limit = payload?.limit ?? 50;
      tt.showToast({
        title: `本月审批已用�?(${used}/${limit})，升�?Pro 解锁无限`,
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
