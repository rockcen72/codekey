import { createApi } from '../../services/api';
import { WsClient } from '../../services/ws';
import { getClientToken, getDeviceId, getServerUrl, clearAuth } from '../../services/storage';

const app = getApp();

Page({
  data: {
    sessions: [] as any[],
    wsConnected: false,
  },

  onShow() {
    this.fetchSessions();
    this.connectWs();
  },

  onHide() {
    // App-level WS — keep alive across page navigation.
    // Disconnected only on unbind/logout.
  },

  async fetchSessions() {
    try {
      const api = createApi(getServerUrl());
      const raw = await api.getSessions();
      const sessions = raw.map(s => ({
        ...s,
        displayTime: this.formatTime(s.last_active_at),
        projectName: s.metadata?.sessionLabel || s.metadata?.projectName || 'Default',
      }));
      this.setData({ sessions });
    } catch (err) {
      console.error('[sessions] fetch error:', err);
    }
  },

  connectWs() {
    const token = getClientToken();
    const deviceId = getDeviceId();
    if (!token || !deviceId) return;

    // WS already active at app level
    if (app.globalData.wsConnected) return;

    const newWs = new WsClient(getServerUrl(), deviceId, token);
    newWs.on('event_push', (payload: any) => {
      if (payload.eventType === 'task_complete') {
        const summary = payload.summaryShort || payload.summary || '';
        const snippet = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
        wx.showToast({ title: '任务完成: ' + snippet, icon: 'none', duration: 3000 });
      }
      this.fetchSessions();
    });
    newWs.on('session_registered', () => {
      this.fetchSessions();
    });
    newWs.on('connected', () => {
      app.globalData.wsConnected = true;
      this.setData({ wsConnected: true });
    });
    newWs.on('disconnected', () => {
      app.globalData.wsConnected = false;
      this.setData({ wsConnected: false });
    });
    newWs.on('auth_failed', () => {
      clearAuth();
      app.globalData.ws = null;
      app.globalData.wsConnected = false;
      wx.redirectTo({ url: '/pages/login/login' });
    });
    newWs.connect();
    app.globalData.ws = newWs;
    // wsConnected set in 'connected' event handler, after SocketTask.onOpen
  },

  openSession(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/session-detail/session-detail?id=${id}` });
  },

  goToSettings() {
    wx.navigateTo({ url: '/pages/settings/settings' });
  },

  formatTime(iso: string): string {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return `${mins} 分钟前`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs} 小时前`;
    return new Date(iso).toLocaleDateString();
  },
});
