import { createApi, Session } from '../../services/api';
import { getServerUrl } from '../../services/storage';

const AGENT_COLORS: Record<string, string> = {
  'claude-code': '#ea580c',
  'claude': '#2563eb',
  'cursor': '#059669',
  'windsurf': '#0891b2',
  'github-copilot': '#d97706',
};

function agentColor(session: Session): string {
  const runtime = session.metadata?.runtime || session.agent_type || '';
  for (const [key, color] of Object.entries(AGENT_COLORS)) {
    if (runtime.includes(key)) return color;
  }
  return '#2563eb';
}

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

const app = getApp<any>();

Page({
  data: {
    sessions: [] as any[],
    wsConnected: false,
    pendingTotal: 0,
    activeTotal: 0,
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

    // Create bound closures so cleanup works
    this._onEventPushBound = (payload: any) => {
      if (payload.eventType === 'task_complete') {
        const summary = payload.summaryShort || payload.summary || '';
        const snippet = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
        wx.showToast({ title: '任务完成: ' + snippet, icon: 'none', duration: 3000 });
      }
      this.fetchSessions();
    };
    this._onFetchSessionsBound = () => this.fetchSessions();
    this._onWsDisconnectedBound = () => this.setData({ wsConnected: false });

    app.onWsEvent('event_push', this._onEventPushBound);
    app.onWsEvent('session_registered', this._onFetchSessionsBound);
    app.onWsEvent('session_deactivated', this._onFetchSessionsBound);
    app.onWsEvent('session_label_updated', this._onFetchSessionsBound);
    app.onWsEvent('ws_connected', this._onFetchSessionsBound);
    app.onWsEvent('ws_disconnected', this._onWsDisconnectedBound);

    // Sync current connection state
    if (app.globalData.wsConnected !== this.data.wsConnected) {
      this.setData({ wsConnected: app.globalData.wsConnected });
    }
  },

  unsubscribeWs() {
    if (this._onEventPushBound) app.offWsEvent('event_push', this._onEventPushBound);
    if (this._onWsDisconnectedBound) app.offWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    if (this._onFetchSessionsBound) {
      app.offWsEvent('session_registered', this._onFetchSessionsBound);
      app.offWsEvent('session_deactivated', this._onFetchSessionsBound);
      app.offWsEvent('session_label_updated', this._onFetchSessionsBound);
      app.offWsEvent('ws_connected', this._onFetchSessionsBound);
    }
    this._onEventPushBound = undefined;
    this._onFetchSessionsBound = undefined;
    this._onWsDisconnectedBound = undefined;
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

  async fetchSessions() {
    try {
      const api = createApi(getServerUrl());
      const raw = await api.getSessions();
      const sessions = raw.map(s => {
        const pendingCount = Number((s as any).pendingCount || (s as any).pending_count || 0);
        const title = sessionTitle(s);
        const subtitle = sessionSubtitle(s);
        const runtime = s.metadata?.runtime || s.agent_type || 'agent';
        const claudeId = s.metadata?.claudeSessionId || '';

        return {
          ...s,
          displayTitle: title,
          displaySubtitle: subtitle,
          displayRuntime: runtime,
          displayClaudeId: claudeId ? claudeId.slice(0, 8) : '',
          displayTime: this.formatTime(s.last_active_at),
          pendingCount,
          hasPending: pendingCount > 0,
          agentColor: agentColor(s),
          statusLabel: s.status === 'active' ? '在线' : '离线',
        };
      });

      const pendingTotal = sessions.reduce((sum, item) => sum + item.pendingCount, 0);
      const activeTotal = sessions.filter((item) => item.status === 'active').length;

      this.setData({ sessions, pendingTotal, activeTotal });
    } catch (err) {
      console.error('[sessions] fetch error:', err);
    }
  },

  openSession(e: any) {
    const id = e.currentTarget.dataset.id;
    wx.navigateTo({ url: `/pages/session-detail/session-detail?id=${id}` });
  },

  detachSession(e: any) {
    const sessionId = e.currentTarget.dataset.id;
    if (!app.globalData.wsConnected) {
      wx.showToast({ title: '未连接服务器，无法取消关联', icon: 'none' });
      return;
    }

    wx.showModal({
      title: '取消关联',
      content: '将结束此会话的 CodeKey 连接并过期待处理的审批请求。',
      success: (res) => {
        if (res.confirm) {
          app.sendWs({ type: 'detach_session', payload: { sessionId } });

          // Optimistically remove from list
          const sessions = this.data.sessions.filter((s: any) => s.id !== sessionId);
          const pendingTotal = sessions.reduce((sum, s) => sum + (s.pendingCount || 0), 0);
          const activeTotal = sessions.filter((s: any) => s.status === 'active').length;
          this.setData({ sessions, pendingTotal, activeTotal });

          // Reconcile from server after 3s
          setTimeout(() => this.fetchSessions(), 3000);
        }
      },
    });
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
