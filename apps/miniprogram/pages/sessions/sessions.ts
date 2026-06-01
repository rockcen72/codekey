import { createApi, Session } from '../../services/api';
import { getServerUrl } from '../../services/storage';

const app = getApp<any>();

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-code-hook': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
};

function agentLabel(agentType: string | undefined): string {
  return agentType ? (AGENT_LABELS[agentType] || agentType) : 'Agent';
}

function collectAgentTabs(sessions: any[]): { key: string; label: string }[] {
  const seen = new Set<string>();
  const tabs: { key: string; label: string }[] = [{ key: 'all', label: 'All' }];
  for (const s of sessions) {
    const key = s.agent_type || s.displayRuntime || 'unknown';
    if (!seen.has(key)) {
      seen.add(key);
      tabs.push({ key, label: agentLabel(key) });
    }
  }
  return tabs;
}

Page({
  data: {
    sessions: [] as any[],
    filteredSessions: [] as any[],
    wsConnected: false,
    deviceOnline: true,
    pendingTotal: 0,
    activeTotal: 0,
    activeTab: 'all',
    agentTabs: [{ key: 'all', label: 'All' }] as { key: string; label: string }[],
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
    this._onWsConnectedBound = () => { this.setData({ wsConnected: true }); this.fetchSessions(); };
    this._onWsDisconnectedBound = () => this.setData({ wsConnected: false });
    this._onDeviceOfflineBound = () => { this.setData({ deviceOnline: false }); this._updateConnectedStates(false); };
    this._onDeviceOnlineBound = () => { this.setData({ deviceOnline: true }); this._updateConnectedStates(true); };

    app.onWsEvent('event_push', this._onEventPushBound);
    app.onWsEvent('session_registered', this._onFetchSessionsBound);
    app.onWsEvent('session_deactivated', this._onFetchSessionsBound);
    app.onWsEvent('session_label_updated', this._onFetchSessionsBound);
    app.onWsEvent('ws_connected', this._onWsConnectedBound);
    app.onWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    app.onWsEvent('device_offline', this._onDeviceOfflineBound);
    app.onWsEvent('device_online', this._onDeviceOnlineBound);

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

  _startPolling() { this._stopPolling(); this._pollTimer = setInterval(() => this.fetchSessions(), 10_000); },
  _stopPolling() { if (this._pollTimer) { clearInterval(this._pollTimer); this._pollTimer = undefined; } },

  _updateConnectedStates(deviceOnline: boolean) {
    const sessions = this.data.sessions.map(s => ({ ...s, connected: s.status === 'active' && deviceOnline }));
    const activeTotal = sessions.filter(s => s.connected).length;
    this.setData({ sessions, activeTotal });
    this._applyFilter(sessions);
  },

  _applyFilter(sessions: any[]) {
    const tab = this.data.activeTab;
    const filtered = tab === 'all' ? sessions : sessions.filter(s => (s.agent_type || s.displayRuntime || 'unknown') === tab);
    this.setData({ filteredSessions: filtered });
  },

  onTabTap(e: any) {
    this.setData({ activeTab: e.currentTarget.dataset.key });
    this._applyFilter(this.data.sessions);
  },

  async fetchSessions() {
    try {
      const api = createApi(getServerUrl());
      const raw = await api.getSessions();
      const deviceOnline = this.data.deviceOnline;
      const sessions = raw.map((s: Session) => {
        const pendingCount = Number((s as any).pendingCount || (s as any).pending_count || 0);
        return {
          ...s,
          displayTitle: sessionTitle(s),
          displaySubtitle: sessionSubtitle(s),
          displayRuntime: s.metadata?.runtime || s.agent_type || 'agent',
          displayAgentLabel: agentLabel(s.agent_type),
          displayClaudeId: (s.metadata?.claudeSessionId || '').slice(0, 8),
          displayTime: this.formatTime(s.last_active_at),
          pendingCount,
          hasPending: pendingCount > 0,
          connected: s.status === 'active' && deviceOnline,
          swiped: false,
        };
      });

      this.setData({
        sessions,
        filteredSessions: sessions,
        agentTabs: collectAgentTabs(sessions),
        pendingTotal: sessions.reduce((sum, item) => sum + item.pendingCount, 0),
        activeTotal: sessions.filter((item) => item.connected).length,
      });
      this._applyFilter(sessions);
    } catch (err) {
      console.error('[sessions] fetch error:', err);
    }
  },

  onTouchStart(e: any) { this._swipeStartX = e.touches[0].clientX; this._swipingId = e.currentTarget.dataset.id; },
  onTouchEnd(e: any) {
    if (!this._swipingId) return;
    const delta = e.changedTouches[0].clientX - this._swipeStartX;
    if (delta < -50) this._openSwipe(this._swipingId); else this._closeAllSwipes();
    this._swipeStartX = 0; this._swipingId = null;
  },
  _openSwipe(id: string) { this.setData({ sessions: this.data.sessions.map(s => ({ ...s, swiped: s.id === id })) }); },
  _closeAllSwipes() { this.setData({ sessions: this.data.sessions.map(s => ({ ...s, swiped: false })) }); },

  deleteSession(e: any) {
    const sessionId = e.currentTarget.dataset.id;
    const sessions = this.data.sessions;
    const session = sessions.find((s: any) => s.id === sessionId);
    if (!session) return;
    wx.showModal({
      title: '删除会话',
      content: '将从列表中移除此会话。如果会话仍处于连接状态，将同时解除关联。',
      success: (res) => {
        if (!res.confirm) { this._closeAllSwipes(); return; }
        if (session.connected && app.globalData.wsConnected) app.sendWs({ type: 'detach_session', payload: { sessionId } });
        const updated = sessions.filter((s: any) => s.id !== sessionId);
        this.setData({ sessions: updated, pendingTotal: updated.reduce((sum, s) => sum + (s.pendingCount || 0), 0), activeTotal: updated.filter((s: any) => s.connected).length });
        this._applyFilter(updated);
        setTimeout(() => this.fetchSessions(), 2000);
      },
    });
  },

  openSession(e: any) { this._closeAllSwipes(); wx.navigateTo({ url: '/pages/session-detail/session-detail?id=' + e.currentTarget.dataset.id }); },
  goToSettings() { wx.navigateTo({ url: '/pages/settings/settings' }); },

  formatTime(iso: string): string {
    if (!iso) return '';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 60000) return '刚刚';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`;
    return new Date(iso).toLocaleDateString();
  },
});

function sessionTitle(session: Session): string {
  return session.metadata?.title || session.metadata?.claudeSessionId?.slice(0, 8) || session.id.slice(0, 8);
}
function sessionSubtitle(session: Session): string {
  return session.metadata?.cwd || session.metadata?.runtime || session.agent_type;
}
