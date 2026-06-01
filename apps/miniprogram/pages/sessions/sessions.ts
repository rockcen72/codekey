import { createApi, Session } from '../../services/api';
import { getServerUrl } from '../../services/storage';

const app = getApp<any>();

Page({
  data: {
    sessions: [] as any[],
    wsConnected: false,
    deviceOnline: true,
    pendingTotal: 0,
    activeTotal: 0,
    _swipedSessionId: null as string | null,
  },

  onShow() {
    this.fetchSessions();
    this.subscribeWs();
    this._startPolling();
  },

  onHide() {
    this.unsubscribeWs();
    this._stopPolling();
  },

  subscribeWs() {
    app.initWs();

    this._onEventPushBound = (payload: any) => {
      if (payload.eventType === 'task_complete') {
        const summary = payload.summaryShort || payload.summary || '';
        const snippet = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
        wx.showToast({ title: '任务完成: ' + snippet, icon: 'none', duration: 3000 });
      }
      this.fetchSessions();
    };
    this._onFetchSessionsBound = () => this.fetchSessions();
    this._onWsConnectedBound = () => {
      this.setData({ wsConnected: true });
      this.fetchSessions();
    };
    this._onWsDisconnectedBound = () => this.setData({ wsConnected: false });
    this._onDeviceOfflineBound = () => {
      this.setData({ deviceOnline: false });
      this._updateConnectedStates(false);
    };
    this._onDeviceOnlineBound = () => {
      this.setData({ deviceOnline: true });
      this._updateConnectedStates(true);
    };

    app.onWsEvent('event_push', this._onEventPushBound);
    app.onWsEvent('session_registered', this._onFetchSessionsBound);
    app.onWsEvent('session_deactivated', this._onFetchSessionsBound);
    app.onWsEvent('session_label_updated', this._onFetchSessionsBound);
    app.onWsEvent('ws_connected', this._onWsConnectedBound);
    app.onWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    app.onWsEvent('device_offline', this._onDeviceOfflineBound);
    app.onWsEvent('device_online', this._onDeviceOnlineBound);

    // Sync initial connection states
    if (app.globalData.wsConnected !== this.data.wsConnected) {
      this.setData({ wsConnected: app.globalData.wsConnected });
    }
  },

  unsubscribeWs() {
    if (this._onEventPushBound) app.offWsEvent('event_push', this._onEventPushBound);
    if (this._onWsConnectedBound) app.offWsEvent('ws_connected', this._onWsConnectedBound);
    if (this._onWsDisconnectedBound) app.offWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    if (this._onDeviceOfflineBound) app.offWsEvent('device_offline', this._onDeviceOfflineBound);
    if (this._onDeviceOnlineBound) app.offWsEvent('device_online', this._onDeviceOnlineBound);
    if (this._onFetchSessionsBound) {
      app.offWsEvent('session_registered', this._onFetchSessionsBound);
      app.offWsEvent('session_deactivated', this._onFetchSessionsBound);
      app.offWsEvent('session_label_updated', this._onFetchSessionsBound);
    }
    this._onEventPushBound = undefined;
    this._onFetchSessionsBound = undefined;
    this._onWsConnectedBound = undefined;
    this._onWsDisconnectedBound = undefined;
    this._onDeviceOfflineBound = undefined;
    this._onDeviceOnlineBound = undefined;
  },

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this.fetchSessions(), 10_000);
  },

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  },

  /** Recompute connected states without a re-fetch (used on device online/offline). */
  _updateConnectedStates(deviceOnline: boolean) {
    const sessions = this.data.sessions.map(s => ({
      ...s,
      connected: s.status === 'active' && deviceOnline,
    }));
    const activeTotal = sessions.filter(s => s.connected).length;
    this.setData({ sessions, activeTotal });
  },

  async fetchSessions() {
    try {
      const api = createApi(getServerUrl());
      const raw = await api.getSessions();
      const deviceOnline = this.data.deviceOnline;
      const sessions = raw.map(s => {
        const pendingCount = Number((s as any).pendingCount || (s as any).pending_count || 0);
        const title = sessionTitle(s);
        const subtitle = sessionSubtitle(s);
        const claudeId = s.metadata?.claudeSessionId || '';

        return {
          ...s,
          displayTitle: title,
          displaySubtitle: subtitle,
          displayRuntime: s.metadata?.runtime || s.agent_type || 'agent',
          displayClaudeId: claudeId ? claudeId.slice(0, 8) : '',
          displayTime: this.formatTime(s.last_active_at),
          pendingCount,
          hasPending: pendingCount > 0,
          connected: s.status === 'active' && deviceOnline,
          swiped: false,
        };
      });

      const pendingTotal = sessions.reduce((sum, item) => sum + item.pendingCount, 0);
      const activeTotal = sessions.filter((item) => item.connected).length;

      this.setData({ sessions, pendingTotal, activeTotal });
    } catch (err) {
      console.error('[sessions] fetch error:', err);
    }
  },

  // ── Swipe-to-delete ──

  onTouchStart(e: any) {
    this._swipeStartX = e.touches[0].clientX;
    this._swipingId = e.currentTarget.dataset.id;
  },

  onTouchEnd(e: any) {
    if (!this._swipingId) return;
    const delta = e.changedTouches[0].clientX - this._swipeStartX;
    if (delta < -50) {
      // Swipe left: open delete for this item, close others
      this._openSwipe(this._swipingId);
    } else {
      // Tap or short move: close any open swipe; let bindtap handle navigation
      this._closeAllSwipes();
    }
    this._swipeStartX = 0;
    this._swipingId = null;
  },

  _openSwipe(id: string) {
    const sessions = this.data.sessions.map(s => ({
      ...s,
      swiped: s.id === id,
    }));
    this.setData({ sessions });
  },

  _closeAllSwipes() {
    const sessions = this.data.sessions.map(s => ({
      ...s,
      swiped: false,
    }));
    this.setData({ sessions });
  },

  // ── Delete / detach ──

  deleteSession(e: any) {
    const sessionId = e.currentTarget.dataset.id;
    const sessions = this.data.sessions;
    const session = sessions.find((s: any) => s.id === sessionId);

    if (!session) return;

    wx.showModal({
      title: '删除会话',
      content: '将从列表中移除此会话。如果会话仍处于连接状态，将同时解除关联。',
      success: (res) => {
        if (!res.confirm) {
          this._closeAllSwipes();
          return;
        }

        // If still connected, detach first
        if (session.connected && app.globalData.wsConnected) {
          app.sendWs({ type: 'detach_session', payload: { sessionId } });
        }

        // Remove from list
        const updated = sessions.filter((s: any) => s.id !== sessionId);
        const pendingTotal = updated.reduce((sum, s) => sum + (s.pendingCount || 0), 0);
        const activeTotal = updated.filter((s: any) => s.connected).length;
        this.setData({ sessions: updated, pendingTotal, activeTotal });

        // Re-fetch after 2s to reconcile
        setTimeout(() => this.fetchSessions(), 2000);
      },
    });
  },

  // ── Navigation ──

  openSession(e: any) {
    // Close any open swipe before navigating
    this._closeAllSwipes();
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

// ── Helpers ──

function sessionTitle(session: Session): string {
  return session.metadata?.title
    || session.metadata?.claudeSessionId?.slice(0, 8)
    || session.id.slice(0, 8);
}

function sessionSubtitle(session: Session): string {
  return session.metadata?.cwd
    || session.metadata?.runtime
    || session.agent_type;
}
