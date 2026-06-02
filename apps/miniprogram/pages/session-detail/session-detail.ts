import { createApi } from '../../services/api';
import { getServerUrl } from '../../services/storage';

const app = getApp<any>();

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
  accent: 'pending' | 'approved' | 'denied' | 'complete' | 'neutral';
  kindBadge: string;
  toolName?: string;
  senderName?: string;
}

Page({
  data: {
    sessionId: '',
    session: null as any,
    events: [] as any[],
    chatMessages: [] as ChatMessage[],
    replyTexts: {} as Record<string, string>,
    commandText: '',
    canSendCommand: false,
    wsConnected: false,
    deviceOnline: true,
    scrollToId: '',
    scrollTop: 0,
    _userScrolledUp: false,
    _viewportHeight: 0,
    approvalSheetOpen: false,
    approvalEvent: null as ChatMessage | null,
    sheetReplyText: '',
  },

  onLoad(query: any) {
    const id = query.id || '';
    this.setData({ sessionId: id });
    this.fetchDetail();
    this.subscribeWs();
  },

  onShow() {
    this.setData({ _userScrolledUp: false });
    this.fetchDetail();
    this._startPolling();
  },

  onHide() {
    this._stopPolling();
  },

  onUnload() {
    this.unsubscribeWs();
    this._stopPolling();
  },

  onScroll(e: any) {
    const detail = e.detail || {};
    const scrollTop = detail.scrollTop || 0;
    const scrollHeight = detail.scrollHeight || 0;

    // Capture viewport height from first scroll event
    let vh = this.data._viewportHeight;
    if (vh <= 0 && scrollHeight > 0) {
      // Estimate viewport height from the element; fall back to 600px
      vh = 600;
      this.setData({ _viewportHeight: vh });
    }

    // User is "near bottom" if within 100px of the bottom
    const nearBottom = (scrollTop + vh >= scrollHeight - 100);

    // Only update if state changed to avoid unnecessary re-renders
    const wasScrolledUp = this.data._userScrolledUp;
    if (!nearBottom !== wasScrolledUp) {
      this.setData({ _userScrolledUp: !nearBottom });
    }
  },

  subscribeWs() {
    // Bound closures for proper cleanup
    this._onEventPushBound = (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
        this.fetchDetail({ scrollToEventId: payload.eventId });
      }
    };
    this._onSessionDeactivatedBound = (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
        wx.showToast({ title: '会话已取消关联', icon: 'none', duration: 2000 });
        setTimeout(() => wx.navigateBack(), 1500);
      }
    };
    this._onWsConnectedBound = () => {
      this.setData({ wsConnected: true });
      this.fetchDetail();
    };
    this._onWsDisconnectedBound = () => {
      this.setData({ wsConnected: false });
    };
    this._onDeviceOfflineBound = () => {
      this.setData({ deviceOnline: false });
    };
    this._onDeviceOnlineBound = () => {
      this.setData({ deviceOnline: true });
    };

    this._onSessionLabelUpdatedBound = (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
        // Re-fetch session to pick up the new metadata.title
        this.fetchDetail();
      }
    };

    app.onWsEvent('event_push', this._onEventPushBound);
    app.onWsEvent('session_deactivated', this._onSessionDeactivatedBound);
    app.onWsEvent('ws_connected', this._onWsConnectedBound);
    app.onWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    app.onWsEvent('device_offline', this._onDeviceOfflineBound);
    app.onWsEvent('device_online', this._onDeviceOnlineBound);
    app.onWsEvent('session_label_updated', this._onSessionLabelUpdatedBound);

    // Sync current connection state
    if (app.globalData.wsConnected !== this.data.wsConnected) {
      this.setData({ wsConnected: app.globalData.wsConnected });
    }
  },

  unsubscribeWs() {
    if (this._onEventPushBound) app.offWsEvent('event_push', this._onEventPushBound);
    if (this._onSessionDeactivatedBound) app.offWsEvent('session_deactivated', this._onSessionDeactivatedBound);
    if (this._onWsConnectedBound) app.offWsEvent('ws_connected', this._onWsConnectedBound);
    if (this._onWsDisconnectedBound) app.offWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    if (this._onDeviceOfflineBound) app.offWsEvent('device_offline', this._onDeviceOfflineBound);
    if (this._onDeviceOnlineBound) app.offWsEvent('device_online', this._onDeviceOnlineBound);
    if (this._onSessionLabelUpdatedBound) app.offWsEvent('session_label_updated', this._onSessionLabelUpdatedBound);
    this._onEventPushBound = undefined;
    this._onSessionDeactivatedBound = undefined;
    this._onWsConnectedBound = undefined;
    this._onWsDisconnectedBound = undefined;
    this._onDeviceOfflineBound = undefined;
    this._onDeviceOnlineBound = undefined;
    this._onSessionLabelUpdatedBound = undefined;
  },

  _startPolling() {
    this._stopPolling();
    this._pollTimer = setInterval(() => this.fetchDetail(), 10_000);
  },

  _stopPolling() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = undefined;
    }
  },

  // ── Data fetching ──

  async fetchDetail(options?: { scrollToEventId?: string }) {
    try {
      const api = createApi(getServerUrl());
      const [session, rawEvents] = await Promise.all([
        api.getSession(this.data.sessionId),
        api.getSessionEvents(this.data.sessionId),
      ]);
      this.setData({
        session: {
          ...session,
          agentType: session.metadata?.sessionLabel || agentDisplayName(session.agent_type),
          metadataTitle: session.metadata?.title || '',
          metadataCwd: session.metadata?.cwd || '',
          metadataClaudeSessionId: session.metadata?.claudeSessionId || '',
          metadataSource: session.metadata?.source || '',
        },
        events: rawEvents,
      });
      this.buildChatMessages(rawEvents, options?.scrollToEventId);
    } catch (err) {
      console.error('[detail] fetch error:', err);
    }
  },

  buildChatMessages(rawEvents: any[], scrollToEventId?: string) {
    // Keep relay insertion order so prompt replay stays before the approval it triggered.
    const sorted = [...rawEvents].sort((a, b) => {
      if (a.created_at !== b.created_at) {
        return a.created_at < b.created_at ? -1 : 1;
      }
      const priority: Record<string, number> = {
        user_prompt: 0,
        approval_required: 1,
      };
      return (priority[a.type] ?? 2) - (priority[b.type] ?? 2);
    });
    const messages: ChatMessage[] = [];
    let lastUserPrompt = '';

    for (const e of sorted) {
      const time = this.formatTime(e.created_at);
      const command = e.data?.command || '';
      const summary = e.data?.summary || e.data?.command || '';
      const summaryShort = e.data?.summaryShort || '';
      const agentName = this.chatAgentName(e.data?.agent || e.data?.agentType);

      // Dedup consecutive user_prompt events with identical content
      if (e.type === 'user_prompt') {
        const prompt = e.data?.prompt || e.data?.summary || '';
        if (prompt === lastUserPrompt) continue;
        lastUserPrompt = prompt;
      }

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
          accent: 'neutral',
          kindBadge: '',
          senderName: '',
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
          accent: 'complete',
          kindBadge: 'DONE',
          senderName: agentName,
        });
        continue;
      }

      if (e.type === 'approval_required') {
        const canApprove = ['low', 'medium'].includes(e.risk_level || '');
        const riskText = RISK_LABELS[e.risk_level as string] || '未知';
        const accent: ChatMessage['accent'] = e.pending
          ? 'pending'
          : e.decision === 'approve'
            ? 'approved'
            : e.decision === 'deny'
              ? 'denied'
              : 'neutral';

        messages.push({
          id: e.id,
          type: 'ai',
          side: 'left',
          content: command || summary,
          displayTime: time,
          typeLabel: '审批请求',
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
          accent,
          kindBadge: e.pending ? 'REQUEST' : (this.getDecisionText(e.decision) || 'DONE'),
          toolName: e.data?.toolName || '',
          senderName: agentName,
        });

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
            accent: 'neutral',
            kindBadge: '',
            senderName: '你',
          });
        }
        continue;
      }

      if (e.type === 'user_prompt') {
        const prompt = e.data?.prompt || e.data?.summary || '';
        // Use original transcript timestamp if available, fallback to DB created_at
        const displayTime = e.data?.timestamp
          ? this.formatTime(e.data.timestamp)
          : time;
        messages.push({
          id: e.id,
          type: 'user',
          side: 'right',
          content: prompt,
          displayTime,
          typeLabel: '',
          isTaskComplete: false,
          command: '',
          summary: prompt,
          risk_level: '',
          riskText: '',
          pending: false,
          decision: '',
          decisionText: '',
          canApprove: false,
          eventId: e.id,
          accent: 'neutral',
          kindBadge: '',
          senderName: '你',
        });
        continue;
      }
    }

    if (messages.length > 0) {
      const pushedIdx = scrollToEventId
        ? messages.findIndex((m: ChatMessage) => m.eventId === scrollToEventId && m.type === 'ai')
        : -1;
      let latestPendingIdx = -1;
      for (let i = messages.length - 1; i >= 0; i--) {
        if (messages[i].pending) {
          latestPendingIdx = i;
          break;
        }
      }
      // Auto-scroll only when:
      // 1. A specific scrollToEventId was requested (new event push)
      // 2. There's a pending approval
      // 3. User is near the bottom (not scrolled up reading history)
      const shouldAutoScroll = pushedIdx !== -1
        || latestPendingIdx !== -1
        || !this.data._userScrolledUp;

      if (shouldAutoScroll) {
        const targetIdx = pushedIdx !== -1
          ? pushedIdx
          : latestPendingIdx !== -1
            ? latestPendingIdx
            : messages.length - 1;
        const targetId = 'msg-' + messages[targetIdx].id;
        // Reset scrollToId first so scroll-into-view always detects the change
        this.setData({ chatMessages: messages, scrollToId: '' }, () => {
          wx.nextTick(() => {
            this.setData({ scrollToId: targetId, scrollTop: Date.now() });
          });
        });
      } else {
        this.setData({ chatMessages: messages });
      }
    } else {
      this.setData({ chatMessages: messages });
    }
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

  // ── Approval bottom sheet ──

  openApprovalSheet(e: any) {
    const eventId = e.currentTarget.dataset.id;
    const approvalEvent = this.data.chatMessages.find((m: ChatMessage) => m.eventId === eventId && m.type === 'ai') || null;
    this.setData({ approvalSheetOpen: !!approvalEvent, approvalEvent, sheetReplyText: '' });
  },

  closeApprovalSheet() {
    this.setData({ approvalSheetOpen: false, approvalEvent: null, sheetReplyText: '' });
  },

  approveSheet() {
    if (!this.data.approvalEvent) return;
    this.sendDecision(this.data.approvalEvent.eventId, 'approve');
    this.closeApprovalSheet();
  },

  denySheet() {
    if (!this.data.approvalEvent) return;
    this.sendDecision(this.data.approvalEvent.eventId, 'deny');
    this.closeApprovalSheet();
  },

  pauseSheet() {
    if (!this.data.approvalEvent) return;
    this.sendDecision(this.data.approvalEvent.eventId, 'pause');
    this.closeApprovalSheet();
  },

  onSheetReplyInput(e: any) {
    this.setData({ sheetReplyText: e.detail.value });
  },

  sendSheetReply() {
    const text = this.data.sheetReplyText.trim();
    if (!text || !this.data.approvalEvent) return;

    const eventId = this.data.approvalEvent.eventId;
    app.sendWs({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision: 'reply', message: text },
    });

    const messages = [...this.data.chatMessages];
    const aiIdx = messages.findIndex((m: ChatMessage) => m.eventId === eventId && m.type === 'ai');
    if (aiIdx !== -1) {
      messages[aiIdx].pending = false;
      messages[aiIdx].decision = 'reply';
      messages[aiIdx].decisionText = '已回复';
      messages[aiIdx].accent = 'neutral';
      messages[aiIdx].kindBadge = '已回复';
    }
    const replyId = eventId + '-reply-' + Date.now();
    messages.push({
      id: replyId,
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
      decision: 'reply',
      decisionText: '已回复',
      canApprove: false,
      eventId,
      accent: 'neutral',
      kindBadge: '',
      senderName: '你',
    });

    this.setData({ chatMessages: messages, sheetReplyText: '' });
    this.closeApprovalSheet();
    setTimeout(() => this.fetchDetail(), 1500);
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
    app.sendWs({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision, message: '' },
    });

    const messages = [...this.data.chatMessages];
    const aiIdx = messages.findIndex((m: ChatMessage) => m.eventId === eventId && m.type === 'ai');
    if (aiIdx !== -1) {
      messages[aiIdx].pending = false;
      messages[aiIdx].decision = decision;
      messages[aiIdx].decisionText = this.getDecisionText(decision);
      messages[aiIdx].accent = decision === 'approve' ? 'approved' : decision === 'deny' ? 'denied' : 'neutral';
      messages[aiIdx].kindBadge = this.getDecisionText(decision);
    }
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
        accent: 'neutral',
        kindBadge: '',
        senderName: '你',
      });
    }
    this.setData({ chatMessages: messages }, () => {
      this.setData({ scrollToId: 'msg-' + messages[messages.length - 1].id });
    });

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

    app.sendWs({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision: 'reply', message: message.trim() },
    });

    const messages = [...this.data.chatMessages];
    const aiIdx = messages.findIndex((m: ChatMessage) => m.eventId === eventId && m.type === 'ai');
    if (aiIdx !== -1) {
      messages[aiIdx].pending = false;
      messages[aiIdx].decision = 'reply';
      messages[aiIdx].decisionText = this.getDecisionText('reply');
      messages[aiIdx].accent = 'neutral';
      messages[aiIdx].kindBadge = this.getDecisionText('reply');
    }
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
      decisionText: this.getDecisionText('reply'),
      canApprove: false,
      eventId,
      accent: 'neutral',
      kindBadge: '',
      senderName: '你',
    });

    const replyTexts = { ...this.data.replyTexts };
    delete replyTexts[eventId];

    this.setData({ chatMessages: messages, replyTexts, scrollToId: 'msg-' + replyId });
    setTimeout(() => this.fetchDetail(), 1500);
  },

  // ── Command input ──

  onCommandInput(e: any) {
    const val = e.detail.value;
    this.setData({ commandText: val, canSendCommand: val.trim() !== '' });
  },

  sendCommand() {
    const text = this.data.commandText.trim();
    if (!text) {
      wx.showToast({ title: '请输入指令', icon: 'none' });
      return;
    }
    if (!app.globalData.wsConnected) {
      wx.showToast({ title: '未连接服务器', icon: 'none' });
      return;
    }
    if (!this.data.deviceOnline) {
      wx.showToast({ title: '设备离线，无法发送指令', icon: 'none' });
      return;
    }
    if (!this.data.session?.status || this.data.session.status !== 'active') {
      wx.showToast({ title: '会话未处于活跃状态', icon: 'none' });
      return;
    }

    app.sendWs({
      type: 'command',
      payload: { sessionId: this.data.sessionId, action: 'write_stdin', data: text },
    });

    this.setData({
      commandText: '',
      canSendCommand: false,
    });
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

  chatAgentName(agentType?: string): string {
    const session = this.data.session || {};
    return agentChatName(agentType || session.agent_type || session.metadata?.runtime);
  },
});

const AGENT_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-code-hook': 'Claude Code',
  'codex': 'Codex',
  'opencode': 'OpenCode',
};

const AGENT_CHAT_NAMES: Record<string, string> = {
  'claude-code': 'claude code',
  'claude-code-hook': 'claude code',
  'codex': 'codex',
  'opencode': 'opencode',
};

function agentDisplayName(agentType?: string): string {
  if (!agentType) return 'AI Agent';
  return AGENT_DISPLAY_NAMES[agentType] || agentType;
}

function agentChatName(agentType?: string): string {
  if (!agentType) return 'agent';
  return AGENT_CHAT_NAMES[agentType] || agentType;
}
