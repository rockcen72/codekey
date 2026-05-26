import { createApi } from '../../services/api';
import { getServerUrl } from '../../services/storage';

const app = getApp();

const RISK_LABELS: Record<string, string> = {
  low: '低风险',
  medium: '中风险',
  high: '高风险',
  critical: '严重风险',
  unknown: '未知',
};

Page({
  data: {
    sessionId: '',
    session: null as any,
    events: [] as any[],
    showApproval: false,
    currentEvent: null as any,
    riskLevel: 'low',
    riskLabel: '',
    replyText: '',
    // Pre-computed approval card fields (avoid method calls / optional chaining in WXML)
    approvalCommand: '',
    approvalSummary: '',
    approvalCwd: '',
    approvalDisabled: false,
    showRiskNotice: false,
    commandText: '',
    wsConnected: false,
  },

  onLoad(query: any) {
    const id = query.id || '';
    this.setData({ sessionId: id });
    this.fetchDetail();
    this.setupWsListener();
  },

  onUnload() {
    // WS listener removed automatically when page is destroyed
  },

  async fetchDetail() {
    try {
      const api = createApi(getServerUrl());
      const [session, rawEvents] = await Promise.all([
        api.getSession(this.data.sessionId),
        api.getSessionEvents(this.data.sessionId),
      ]);
      const events = rawEvents.map(e => ({
        ...e,
        displayTime: this.formatTime(e.created_at),
        summary: e.data?.summary || e.data?.command || '',
        summaryShort: e.data?.summaryShort || '',
        riskText: RISK_LABELS[e.risk_level as string] || '未知',
        showPending: e.pending && e.type === 'approval_required',
        showDecision: !e.pending && e.decision,
        isTaskComplete: e.type === 'task_complete',
      }));
      this.setData({ session: { ...session, agentType: session.agent_type || 'AI Agent' }, events });
    } catch (err) {
      console.error('[detail] fetch error:', err);
    }
  },

  setupWsListener() {
    const ws = app.globalData.ws as any;
    if (!ws) return;

    this.setData({ wsConnected: true });

    ws.on('event_push', (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
        if (payload.eventType === 'task_complete') {
          const summary = payload.summaryShort || payload.summary || '';
          const snippet = summary.length > 80 ? summary.slice(0, 80) + '...' : summary;
          wx.showToast({ title: '任务完成: ' + snippet, icon: 'none', duration: 3000 });
        }
        this.fetchDetail();
      }
    });

    ws.on('disconnected', () => {
      this.setData({ wsConnected: false });
    });

    ws.on('connected', () => {
      this.setData({ wsConnected: true });
    });
  },

  showApprovalCard(e: any) {
    const eventId = e.currentTarget.dataset.id;
    const event = this.data.events.find((ev: any) => ev.id === eventId);
    if (!event) return;
    const riskLevel = event.risk_level || 'unknown';
    const cannotApprove = !this.canApprove(riskLevel);
    this.setData({
      showApproval: true,
      currentEvent: event,
      riskLevel,
      riskLabel: RISK_LABELS[riskLevel] || '未知',
      replyText: '',
      approvalCommand: event.data?.command || '',
      approvalSummary: event.data?.summary || '',
      approvalCwd: event.data?.cwd || '',
      approvalDisabled: cannotApprove,
      showRiskNotice: cannotApprove,
    });
  },

  closeApprovalCard() {
    this.setData({ showApproval: false, currentEvent: null });
  },

  approve() {
    this.sendDecision('approve');
  },

  deny() {
    this.sendDecision('deny');
  },

  pause() {
    this.sendDecision('pause');
  },

  onReplyInput(e: any) {
    this.setData({ replyText: e.detail.value });
  },

  sendReply() {
    if (this.data.replyText.trim()) {
      this.sendDecision('reply', this.data.replyText.trim());
    }
  },

  sendDecision(decision: string, message = '') {
    const ws = app.globalData.ws as any;
    if (!ws || !this.data.currentEvent) return;

    const eventId = this.data.currentEvent.id;
    this.closeApprovalCard();

    // Register one-time error handler BEFORE send
    let hadError = false;
    const errorHandler = (errPayload: any) => {
      hadError = true;
      if (errPayload.code === 'RISK_TOO_HIGH') {
        wx.showToast({ title: '无法批准此风险等级', icon: 'none' });
      } else if (errPayload.code === 'ALREADY_RESPONDED') {
        wx.showToast({ title: '已处理过此请求', icon: 'none' });
      } else {
        wx.showToast({ title: '错误：' + (errPayload.message || errPayload.code), icon: 'none' });
      }
      ws.off('error', errorHandler);
      this.fetchDetail();
    };
    ws.on('error', errorHandler);

    ws.send({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision, message },
    });

    // Optimistic UI — only show success if no error arrived
    setTimeout(() => {
      if (!hadError) {
        ws.off('error', errorHandler);
        wx.showToast({
          title: decision === 'approve' ? '已批准' : decision === 'deny' ? '已拒绝' : '已发送',
          icon: 'success',
        });
      }
      this.fetchDetail();
    }, 1000);
  },

  onCommandInput(e: any) {
    this.setData({ commandText: e.detail.value });
  },

  sendCommand() {
    const text = this.data.commandText.trim();
    if (!text) {
      wx.showToast({ title: '请输入指令', icon: 'none' });
      return;
    }

    const ws = app.globalData.ws as any;
    if (!ws || !this.data.wsConnected) {
      wx.showToast({ title: '未连接服务器', icon: 'none' });
      return;
    }

    if (!this.data.session?.status || this.data.session.status !== 'active') {
      wx.showToast({ title: '会话未处于活跃状态', icon: 'none' });
      return;
    }

    ws.send({
      type: 'command',
      payload: { sessionId: this.data.sessionId, action: 'write_stdin', data: text },
    });

    this.setData({ commandText: '' });
    wx.showToast({ title: '指令已发送', icon: 'success' });
  },

  goBack() {
    wx.navigateBack();
  },

  formatTime(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  },

  canApprove(risk: string): boolean {
    return ['low', 'medium'].includes(risk);
  },
});
