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

interface ChatMessage {
  id: string;
  type: 'ai' | 'user' | 'system';
  side: 'left' | 'right';
  content: string;
  displayTime: string;
  typeLabel: string;
  isTaskComplete: boolean;
  command: string;
  summary: string;
  risk_level: string;
  riskText: string;
  pending: boolean;
  decision: string;
  decisionText: string;
  canApprove: boolean;
  eventId: string;
}

Page({
  data: {
    sessionId: '',
    session: null as any,
    events: [] as any[],
    chatMessages: [] as ChatMessage[],
    replyTexts: {} as Record<string, string>,
    commandText: '',
    wsConnected: false,
    scrollToId: '',
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
      this.setData({
        session: { ...session, agentType: session.metadata?.sessionLabel || session.agent_type || 'AI Agent' },
        events: rawEvents,
      });
      this.buildChatMessages(rawEvents);
    } catch (err) {
      console.error('[detail] fetch error:', err);
    }
  },

  buildChatMessages(rawEvents: any[]) {
    const messages: ChatMessage[] = [];
    let lastDecisionMap: Record<string, string> = {};

    for (const e of rawEvents) {
      const time = this.formatTime(e.created_at);
      const command = e.data?.command || '';
      const summary = e.data?.summary || e.data?.command || '';
      const summaryShort = e.data?.summaryShort || '';

      if (e.type === 'session_idle') {
        messages.push({
          id: e.id + '-sys',
          type: 'system',
          side: 'left',
          content: 'AI 代理等待指令中...',
          displayTime: time,
          typeLabel: '',
          isTaskComplete: false,
          command: '',
          summary: '',
          risk_level: '',
          riskText: '',
          pending: false,
          decision: '',
          decisionText: '',
          canApprove: false,
          eventId: e.id,
        });
        continue;
      }

      if (e.type === 'task_complete') {
        messages.push({
          id: e.id,
          type: 'ai',
          side: 'left',
          content: summaryShort || summary,
          displayTime: time,
          typeLabel: '任务完成',
          isTaskComplete: true,
          command: '',
          summary: summaryShort || summary,
          risk_level: '',
          riskText: '',
          pending: false,
          decision: '',
          decisionText: '',
          canApprove: false,
          eventId: e.id,
        });
        continue;
      }

      if (e.type === 'approval_required') {
        // AI left message: command + risk
        const canApprove = ['low', 'medium'].includes(e.risk_level || '');
        const riskText = RISK_LABELS[e.risk_level as string] || '未知';

        messages.push({
          id: e.id,
          type: 'ai',
          side: 'left',
          content: command || summary,
          displayTime: time,
          typeLabel: '命令执行请求',
          isTaskComplete: false,
          command,
          summary,
          risk_level: e.risk_level || 'unknown',
          riskText,
          pending: e.pending,
          decision: e.decision || '',
          decisionText: !e.pending ? this.getDecisionText(e.decision) : '',
          canApprove,
          eventId: e.id,
        });

        // User right message: decision
        if (!e.pending && e.decision) {
          const decisionContent = this.getDecisionText(e.decision);
          messages.push({
            id: e.id + '-decision',
            type: 'user',
            side: 'right',
            content: decisionContent,
            displayTime: time,
            typeLabel: '',
            isTaskComplete: false,
            command: '',
            summary: '',
            risk_level: '',
            riskText: '',
            pending: false,
            decision: e.decision,
            decisionText: decisionContent,
            canApprove: false,
            eventId: e.id,
          });
        }
      }
    }

    this.setData({ chatMessages: messages }, () => {
      // Scroll to bottom
      if (messages.length > 0) {
        this.setData({ scrollToId: 'msg-' + messages[messages.length - 1].id });
      }
    });
  },

  getDecisionText(decision: string): string {
    switch (decision) {
      case 'approve': return '已批准';
      case 'deny': return '已拒绝';
      case 'pause': return '已暂缓';
      case 'reply': return '已回复';
      default: return decision;
    }
  },

  setupWsListener() {
    const ws = app.globalData.ws as any;
    if (!ws) return;

    this.setData({ wsConnected: true });

    ws.on('event_push', (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
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

  // ── Inline approval actions ──

  approveEvent(e: any) {
    const eventId = e.currentTarget.dataset.id;
    this.sendDecision(eventId, 'approve');
  },

  denyEvent(e: any) {
    const eventId = e.currentTarget.dataset.id;
    this.sendDecision(eventId, 'deny');
  },

  pauseEvent(e: any) {
    const eventId = e.currentTarget.dataset.id;
    this.sendDecision(eventId, 'pause');
  },

  sendDecision(eventId: string, decision: string) {
    const ws = app.globalData.ws as any;
    if (!ws) return;

    ws.send({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision, message: '' },
    });

    // Optimistic: update local chat to show decision immediately
    const messages = [...this.data.chatMessages];
    const aiIdx = messages.findIndex((m: ChatMessage) => m.eventId === eventId && m.type === 'ai');
    if (aiIdx !== -1) {
      messages[aiIdx].pending = false;
      messages[aiIdx].decision = decision;
      messages[aiIdx].decisionText = this.getDecisionText(decision);
    }
    // Add user decision bubble
    const decisionContent = this.getDecisionText(decision);
    const dupIdx = messages.findIndex((m: ChatMessage) => m.eventId === eventId + '-decision');
    if (dupIdx === -1) {
      messages.push({
        id: eventId + '-decision',
        type: 'user',
        side: 'right',
        content: decisionContent,
        displayTime: '',
        typeLabel: '',
        isTaskComplete: false,
        command: '',
        summary: '',
        risk_level: '',
        riskText: '',
        pending: false,
        decision,
        decisionText: decisionContent,
        canApprove: false,
        eventId,
      });
    }
    this.setData({ chatMessages: messages }, () => {
      this.setData({ scrollToId: 'msg-' + messages[messages.length - 1].id });
    });

    // Re-fetch after a brief delay to sync
    setTimeout(() => this.fetchDetail(), 1500);
  },

  // ── Reply ──

  onReplyInput(e: any) {
    const eventId = e.currentTarget.dataset.id;
    const val = e.detail.value;
    this.setData({
      [`replyTexts.${eventId}`]: val,
    });
  },

  sendReply(e: any) {
    const eventId = e.currentTarget.dataset.id;
    const message = this.data.replyTexts[eventId] || '';
    if (!message.trim()) return;

    const ws = app.globalData.ws as any;
    if (!ws) return;

    ws.send({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision: 'reply', message: message.trim() },
    });

    // Optimistic: add user reply bubble
    const messages = [...this.data.chatMessages];
    const replyId = eventId + '-reply-' + Date.now();
    messages.push({
      id: replyId,
      type: 'user',
      side: 'right',
      content: message.trim(),
      displayTime: '',
      typeLabel: '',
      isTaskComplete: false,
      command: '',
      summary: '',
      risk_level: '',
      riskText: '',
      pending: false,
      decision: 'reply',
      decisionText: message.trim(),
      canApprove: false,
      eventId,
    });

    const replyTexts = { ...this.data.replyTexts };
    delete replyTexts[eventId];

    this.setData({ chatMessages: messages, replyTexts, scrollToId: 'msg-' + replyId });
    setTimeout(() => this.fetchDetail(), 1500);
  },

  // ── Command input ──

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

    // Add sent message to chat
    const messages = [...this.data.chatMessages];
    const cmdId = 'cmd-' + Date.now();
    messages.push({
      id: cmdId,
      type: 'user',
      side: 'right',
      content: text,
      displayTime: '',
      typeLabel: '',
      isTaskComplete: false,
      command: '',
      summary: '',
      risk_level: '',
      riskText: '',
      pending: false,
      decision: '',
      decisionText: '',
      canApprove: false,
      eventId: '',
    });
    this.setData({ chatMessages: messages, commandText: '', scrollToId: 'msg-' + cmdId });
    wx.showToast({ title: '指令已发送', icon: 'success' });
  },

  // ── Navigation ──

  goBack() {
    wx.navigateBack();
  },

  formatTime(iso: string): string {
    if (!iso) return '';
    const d = new Date(iso);
    const h = d.getHours().toString().padStart(2, '0');
    const m = d.getMinutes().toString().padStart(2, '0');
    return h + ':' + m;
  },
});
