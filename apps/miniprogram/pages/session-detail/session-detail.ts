import { createApi } from '../../services/api';
import { getServerUrl } from '../../services/storage';
import { getSubscription, type UsageSnapshot } from '../../services/subscription';

const app = getApp<any>();

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Lightweight markdown → HTML for mp-html component.
 *  Outputs safe HTML subset supported by mp-html (h1-6, p, ul/ol, table, code, blockquote, hr, strong, em, inline code). */
function markdownToHtml(md: string): string {
  if (!md) return '';
  const lines = md.split('\n');
  const out: string[] = [];
  let inCode = false;
  let inList = false;
  let listType: 'ul' | 'ol' | null = null;

  const flushList = () => {
    if (inList) {
      out.push(listType === 'ol' ? '</ol>' : '</ul>');
      inList = false;
      listType = null;
    }
  };

  for (const raw of lines) {
    // Fenced code block
    if (raw.trimStart().startsWith('```')) {
      flushList();
      if (inCode) {
        out.push('</code></pre>');
        inCode = false;
      } else {
        out.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(escapeHtml(raw));
      continue;
    }

    let line = raw.trim();

    // Headers
    const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
    if (hMatch) {
      flushList();
      const level = hMatch[1].length;
      out.push(`<h${level}>${escapeHtml(hMatch[2])}</h${level}>`);
      continue;
    }

    // Horizontal rule
    if (/^[-*_]{3,}$/.test(line)) {
      flushList();
      out.push('<hr>');
      continue;
    }

    // Unordered list
    if (/^[-*+]\s+/.test(line)) {
      if (!inList || listType !== 'ul') { flushList(); out.push('<ul>'); inList = true; listType = 'ul'; }
      out.push(`<li>${escapeHtml(line.replace(/^[-*+]\s+/, ''))}</li>`);
      continue;
    }

    // Ordered list
    if (/^\d+\.\s+/.test(line)) {
      if (!inList || listType !== 'ol') { flushList(); out.push('<ol>'); inList = true; listType = 'ol'; }
      out.push(`<li>${escapeHtml(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    // Blockquote
    if (/^>\s?/.test(line)) {
      flushList();
      out.push(`<blockquote>${escapeHtml(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    // ASCII table (CC format: +---+---+, | a | b |)
    if (/^[\|+][-+\s|:]*[\|+]/.test(line) && line.includes('|')) {
      flushList();
      // Skip separator rows (+---+)
      if (/^\+/.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
      if (cells.length === 0) continue;
      const isFirstRow = out.length === 0 || !out[out.length - 1].includes('flex-direction:row');
      const bg = isFirstRow ? 'background:#f5f5f4;font-weight:700' : '';
      out.push('<div style="display:flex;flex-direction:row;width:100%">');
      for (const c of cells) {
        out.push(`<div style="flex:1;min-width:0;padding:6rpx 8rpx;border:1rpx solid #d1d5db;font-size:24rpx;word-break:break-word;${bg}">${escapeHtml(c)}</div>`);
      }
      out.push('</div>');
      continue;
    }

    // Markdown table (| col | col |)
    if (/^\|.*\|$/.test(line)) {
      flushList();
      if (/^\|[\s:-]+\|$/.test(line)) continue;
      const cells = line.split('|').filter(c => c.trim()).map(c => c.trim());
      const isFirstRow = out.length === 0 || !out[out.length - 1].includes('flex-direction:row');
      const bg = isFirstRow ? 'background:#f5f5f4;font-weight:700' : '';
      out.push('<div style="display:flex;flex-direction:row;width:100%">');
      for (const c of cells) {
        out.push(`<div style="flex:1;min-width:0;padding:6rpx 8rpx;border:1rpx solid #d1d5db;font-size:24rpx;word-break:break-word;${bg}">${escapeHtml(c)}</div>`);
      }
      out.push('</div>');
      continue;
    }

    // Paragraph / regular line
    if (line) {
      flushList();
      // Inline formatting: **bold**, *italic*, `code`
      let html = escapeHtml(line)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
      out.push(`<p>${html}</p>`);
    } else if (out.length > 0 && !out[out.length - 1].startsWith('<') && !out[out.length - 1].startsWith('</')) {
      // empty line between paragraphs
      flushList();
    }
  }

  flushList();
  if (inCode) out.push('</code></pre>');

  // Close table if still open
  if (out.length > 0 && out[out.length - 1].startsWith('<table>')) {
    out.push('</table>');
  }

  return out.join('\n');
}

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
  agentClass: 'claude' | 'codex' | 'opencode' | 'unknown';
  kindBadge: string;
  toolName?: string;
  senderName?: string;
  requiresInput?: boolean;
  inputOptions?: { label: string; value: string; description?: string }[];
  contentHtml?: string; // HTML for mp-html component (task_complete markdown)
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
    primaryPendingEvent: null as ChatMessage | null,
    hasPrimaryPendingEvent: false,
    sheetReplyText: '',
    dockExpanded: true,
    dockReplyText: '',
    mpHtmlTagStyle: {
      h1: 'font-size:32rpx;font-weight:800;margin:14rpx 0 6rpx;display:block',
      h2: 'font-size:30rpx;font-weight:800;margin:14rpx 0 6rpx;display:block',
      h3: 'font-size:28rpx;font-weight:800;margin:14rpx 0 6rpx;display:block',
      h4: 'font-size:26rpx;font-weight:800;margin:14rpx 0 6rpx;display:block',
      p: 'margin:6rpx 0;line-height:1.6;display:block',
      ul: 'padding-left:36rpx;margin:8rpx 0;display:block',
      ol: 'padding-left:36rpx;margin:8rpx 0;display:block',
      li: 'margin:4rpx 0;line-height:1.6;display:list-item',
      pre: 'background:#1c1917;color:#e7e5e4;padding:12rpx 16rpx;border-radius:8rpx;font-size:22rpx;line-height:1.5;margin:12rpx 0;white-space:pre-wrap;overflow:auto;display:block',
      code: 'background:#f1f0ec;padding:2rpx 8rpx;border-radius:4rpx;font-family:monospace;font-size:22rpx;display:inline',
      blockquote: 'border-left:4rpx solid #d1d5db;padding-left:16rpx;margin:8rpx 0;color:#6b7280;font-style:italic;display:block',
      hr: 'border:none;border-top:1rpx solid #e5e5e5;margin:16rpx 0;display:block',
      table: 'width:100%;border-collapse:collapse;margin:8rpx 0;font-size:24rpx',
      strong: 'font-weight:800',
      em: 'font-style:italic',
    },
    quotaState: 'hidden' as 'hidden' | 'normal' | 'approaching' | 'exhausted',
    quotaPercent: 0,
    usage: null as UsageSnapshot | null,
  },

  onLoad(query: any) {
    const id = query.id || '';
    this.setData({ sessionId: id });
    this.fetchDetail();
    this.fetchSubscription();
    this.subscribeWs();
  },

  onShow() {
    this.setData({ _userScrolledUp: false });
    this.fetchDetail();
    this.fetchSubscription();
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
    this._onWsErrorBound = (payload: any) => {
      const code = payload?.code || '';
      const title = code === 'BRIDGE_NOT_CONNECTED'
        ? '桌面端未连接'
        : code === 'RISK_TOO_HIGH'
          ? '风险过高，不能批准'
          : code === 'ALREADY_RESPONDED'
            ? '审批已处理'
            : '操作失败';
      wx.showToast({ title, icon: 'none', duration: 2000 });
      this.fetchDetail();
    };

    this._onSessionLabelUpdatedBound = (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
        // Re-fetch session to pick up the new metadata.title
        this.fetchDetail();
      }
    };

    this._onQuotaExceededBound = () => {
      // Re-fetch the per-user quota snapshot so the top bar
      // updates immediately instead of waiting for the next
      // onShow. Toast dedounce in app.ts prevents UI flooding.
      this.fetchSubscription();
    };

    this._onEventResolvedBound = (payload: any) => {
      if (payload.sessionId !== this.data.sessionId) return;
      // Immediately dismiss the resolved event locally — don't wait for fetchDetail.
      const eventId = payload.eventId;
      if (eventId) {
        const messages = [...this.data.chatMessages];
        const idx = messages.findIndex((m: ChatMessage) => m.eventId === eventId && m.pending);
        if (idx !== -1) {
          messages[idx].pending = false;
          messages[idx].decision = 'resolved';
          messages[idx].decisionText = '已在桌面端处理';
          messages[idx].accent = 'neutral';
          messages[idx].canApprove = false;
          messages[idx].kindBadge = 'DONE';
          const primaryPendingEvent = this.getPrimaryPendingEvent(messages);
          this.setData({
            chatMessages: messages,
            primaryPendingEvent,
            hasPrimaryPendingEvent: !!primaryPendingEvent,
          });
        }
      }
      // Still fetch to get authoritative state from server
      this.fetchDetail();
    };

    this._onAuthFailedBound = () => { wx.redirectTo({ url: '/pages/login/login' }); };

    app.onWsEvent('event_push', this._onEventPushBound);
    app.onWsEvent('event_resolved', this._onEventResolvedBound);
    app.onWsEvent('session_deactivated', this._onSessionDeactivatedBound);
    app.onWsEvent('auth_failed', this._onAuthFailedBound);
    app.onWsEvent('ws_connected', this._onWsConnectedBound);
    app.onWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    app.onWsEvent('device_offline', this._onDeviceOfflineBound);
    app.onWsEvent('device_online', this._onDeviceOnlineBound);
    app.onWsEvent('error', this._onWsErrorBound);
    app.onWsEvent('session_label_updated', this._onSessionLabelUpdatedBound);
    app.onWsEvent('quota_exceeded', this._onQuotaExceededBound);

    // Sync current connection state
    if (app.globalData.wsConnected !== this.data.wsConnected) {
      this.setData({ wsConnected: app.globalData.wsConnected });
    }
  },

  unsubscribeWs() {
    if (this._onEventResolvedBound) app.offWsEvent('event_resolved', this._onEventResolvedBound);
    if (this._onAuthFailedBound) app.offWsEvent('auth_failed', this._onAuthFailedBound);
    if (this._onEventPushBound) app.offWsEvent('event_push', this._onEventPushBound);
    if (this._onSessionDeactivatedBound) app.offWsEvent('session_deactivated', this._onSessionDeactivatedBound);
    if (this._onWsConnectedBound) app.offWsEvent('ws_connected', this._onWsConnectedBound);
    if (this._onWsDisconnectedBound) app.offWsEvent('ws_disconnected', this._onWsDisconnectedBound);
    if (this._onDeviceOfflineBound) app.offWsEvent('device_offline', this._onDeviceOfflineBound);
    if (this._onDeviceOnlineBound) app.offWsEvent('device_online', this._onDeviceOnlineBound);
    if (this._onWsErrorBound) app.offWsEvent('error', this._onWsErrorBound);
    if (this._onSessionLabelUpdatedBound) app.offWsEvent('session_label_updated', this._onSessionLabelUpdatedBound);
    if (this._onQuotaExceededBound) app.offWsEvent('quota_exceeded', this._onQuotaExceededBound);
    this._onEventResolvedBound = undefined;
    this._onEventPushBound = undefined;
    this._onSessionDeactivatedBound = undefined;
    this._onWsConnectedBound = undefined;
    this._onWsDisconnectedBound = undefined;
    this._onDeviceOfflineBound = undefined;
    this._onDeviceOnlineBound = undefined;
    this._onWsErrorBound = undefined;
    this._onSessionLabelUpdatedBound = undefined;
    this._onQuotaExceededBound = undefined;
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

  async fetchSubscription() {
    // Pulls the per-user subscription (including the free-tier
    // monthly usage counter) so the top bar can show "X/50".
    // Silently no-ops on auth/network failure — the top bar just
    // stays hidden, which is correct (we can't show a quota for
    // paid/trial when we don't know the tier).
    try {
      const sub = await getSubscription();
      const usage = sub.tier === 'free' ? sub.usage : null;
      const quotaState: 'hidden' | 'normal' | 'approaching' | 'exhausted' = !usage
        ? 'hidden'
        : usage.used >= usage.limit
          ? 'exhausted'
          : usage.used >= Math.floor(usage.limit * 0.8)
            ? 'approaching'
            : 'normal';
      const quotaPercent = usage
        ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
        : 0;
      this.setData({ usage, quotaState, quotaPercent });
    } catch (err) {
      console.warn('[session-detail] fetchSubscription failed:', err);
    }
  },

  async fetchDetail(options?: { scrollToEventId?: string }) {
    try {
      const api = createApi(getServerUrl());
      const [session, rawEvents] = await Promise.all([
        api.getSession(this.data.sessionId),
        api.getSessionEvents(this.data.sessionId),
      ]);

      // Detect stale pending events: if a previously-pending event is no longer
      // pending in the fresh data (desktop approved, timeout, etc.), mark it
      // resolved locally. This catches cases where the event_resolved WS
      // message was lost (background, weak network, reconnect gap).
      const freshEventMap = new Map<string, any>();
      for (const e of rawEvents) freshEventMap.set(e.id, e);
      const stalePending = this.data.chatMessages.filter(
        (m: ChatMessage) => m.pending && m.type === 'ai' && m.eventId
      );
      for (const msg of stalePending) {
        const fresh = freshEventMap.get(msg.eventId);
        if (!fresh || !fresh.pending) {
          // Event resolved on server but we missed the WS notification
          const idx = this.data.chatMessages.indexOf(msg);
          if (idx !== -1) {
            this.data.chatMessages[idx].pending = false;
            this.data.chatMessages[idx].decision = fresh?.decision || 'resolved';
            this.data.chatMessages[idx].decisionText = this.getDecisionText(fresh?.decision || 'resolved_by_bridge');
            this.data.chatMessages[idx].accent = 'neutral';
            this.data.chatMessages[idx].canApprove = false;
            this.data.chatMessages[idx].kindBadge = 'DONE';
          }
        }
      }

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
        command_started: 1,
        approval_required: 2,
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
      const output = e.data?.output || '';
      const eventAgentType = e.data?.agent || e.data?.agentType || e.agent || e.agent_type;
      const agentName = this.chatAgentName(eventAgentType);
      const agentClass = agentColorClass(eventAgentType || this.data.session?.agent_type || this.data.session?.metadata?.runtime);

      // Dedup consecutive user_prompt events with identical content
      if (e.type === 'user_prompt') {
        const prompt = e.data?.prompt || e.data?.summary || '';
        if (prompt === lastUserPrompt) continue;
        lastUserPrompt = prompt;
      }

      if (e.type === 'error') {
        messages.push({
          id: e.id + '-err',
          type: 'ai',
          side: 'left',
          content: e.data?.message || e.data?.summary || 'Unknown error',
          displayTime: time,
          typeLabel: '错误',
          isTaskComplete: false,
          command: '',
          summary: e.data?.message || '',
          risk_level: '',
          riskText: '',
          pending: false,
          decision: '',
          decisionText: '',
          canApprove: false,
          eventId: e.id,
          accent: 'denied',
          kindBadge: '',
        });
        continue;
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
          agentClass: 'unknown',
          kindBadge: '',
          senderName: '',
        });
        continue;
      }

      if (e.type === 'command_started') {
        messages.push({
          id: e.id,
          type: 'ai',
          side: 'left',
          content: '电脑端已接收，正在交给 Agent 处理...',
          displayTime: time,
          typeLabel: '正在处理',
          isTaskComplete: false,
          command: '',
          summary: '电脑端已接收，正在交给 Agent 处理...',
          risk_level: '',
          riskText: '',
          pending: false,
          decision: '',
          decisionText: '',
          canApprove: false,
          eventId: e.id,
          accent: 'pending',
          agentClass,
          kindBadge: 'RUNNING',
          senderName: agentName,
        });
        continue;
      }

      if (e.type === 'task_complete') {
        const taskText = output || summary || summaryShort;
        messages.push({
          id: e.id,
          type: 'ai',
          side: 'left',
          content: taskText,
          contentHtml: markdownToHtml(taskText),
          displayTime: time,
          typeLabel: '任务完成',
          isTaskComplete: true,
          command: '',
          summary: taskText,
          risk_level: '',
          riskText: '',
          pending: false,
          decision: '',
          decisionText: '',
          canApprove: false,
          eventId: e.id,
          accent: 'complete',
          agentClass,
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
          agentClass,
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
            agentClass: 'unknown',
            kindBadge: '',
            senderName: '你',
          });
        }
        continue;
      }

      if (e.type === 'input_required') {
        const questions = Array.isArray(e.data?.questions) ? e.data.questions : [];
        const inputOptions = this.extractInputOptions(questions);
        const accent: ChatMessage['accent'] = e.pending ? 'pending' : 'neutral';

        messages.push({
          id: e.id,
          type: 'ai',
          side: 'left',
          content: this.formatInputContent(e.data || {}),
          displayTime: time,
          typeLabel: '选择请求',
          isTaskComplete: false,
          command: '',
          summary: e.data?.summary || 'Agent 需要你的选择',
          risk_level: e.risk_level || 'medium',
          riskText: '',
          pending: e.pending,
          decision: e.decision || '',
          decisionText: !e.pending ? this.getDecisionText(e.decision) : '',
          canApprove: false,
          eventId: e.id,
          accent,
          agentClass,
          kindBadge: e.pending ? 'INPUT' : (this.getDecisionText(e.decision) || 'DONE'),
          senderName: agentName,
          requiresInput: true,
          inputOptions,
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
            agentClass: 'unknown',
            kindBadge: '',
            senderName: '你',
          });
        }
        continue;
      }

      if (e.type === 'user_prompt') {
        const prompt = e.data?.prompt || e.data?.summary || '';
        const displayTime = e.data?.timestamp
          ? this.formatTime(e.data.timestamp)
          : time;
        messages.push({
          id: e.id,
          type: eventAgentType ? 'ai' : 'user',
          side: eventAgentType ? 'left' : 'right',
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
          agentClass: eventAgentType ? agentClass : 'unknown',
          kindBadge: '',
          senderName: eventAgentType ? agentName : '你',
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

      const primaryPendingEvent = this.getPrimaryPendingEvent(messages);
      const pendingState = {
        primaryPendingEvent,
        hasPrimaryPendingEvent: !!primaryPendingEvent,
      };

      if (shouldAutoScroll) {
        const targetIdx = pushedIdx !== -1
          ? pushedIdx
          : latestPendingIdx !== -1
            ? latestPendingIdx
            : messages.length - 1;
        const targetId = 'msg-' + messages[targetIdx].id;
        // Reset scrollToId first so scroll-into-view always detects the change
        this.setData({ chatMessages: messages, scrollToId: '', ...pendingState }, () => {
          wx.nextTick(() => {
            this.setData({ scrollToId: targetId, scrollTop: Date.now() });
          });
        });
      } else {
        this.setData({ chatMessages: messages, ...pendingState });
      }
    } else {
      this.setData({ chatMessages: messages, primaryPendingEvent: null, hasPrimaryPendingEvent: false });
    }
  },

  getPrimaryPendingEvent(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'ai' && msg.pending) return msg;
    }
    return null;
  },

  getDecisionText(decision: string): string {
    switch (decision) {
      case 'approve': return '已批准';
      case 'deny': return '已拒绝';
      case 'pause': return '已暂缓';
      case 'reply': return '已回复';
      case 'resolved_by_bridge': return '已在桌面端处理';
      default: return decision;
    }
  },

  // ── Approval modal ──

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
      agentClass: 'unknown',
      kindBadge: '',
      senderName: '你',
    });

    const primaryPendingEvent = this.getPrimaryPendingEvent(messages);
    this.setData({
      chatMessages: messages,
      primaryPendingEvent,
      hasPrimaryPendingEvent: !!primaryPendingEvent,
      sheetReplyText: '',
    });
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

  // ── Dock overlay ──

  toggleDockExpand() {
    this.setData({ dockExpanded: !this.data.dockExpanded });
  },

  onDockReplyInput(e: any) {
    this.setData({ dockReplyText: e.detail.value });
  },

  sendDockReply() {
    const text = this.data.dockReplyText.trim();
    if (!text || !this.data.primaryPendingEvent) return;

    const eventId = this.data.primaryPendingEvent.eventId;
    app.sendWs({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision: 'reply', message: text },
    });

    // Optimistic UI: mark resolved, add user bubble
    const messages = [...this.data.chatMessages];
    const aiIdx = messages.findIndex((m: ChatMessage) => m.eventId === eventId && m.type === 'ai');
    if (aiIdx !== -1) {
      messages[aiIdx].pending = false;
      messages[aiIdx].decision = 'reply';
      messages[aiIdx].decisionText = '已回复';
      messages[aiIdx].accent = 'neutral';
      messages[aiIdx].canApprove = false;
      messages.splice(aiIdx + 1, 0, {
        id: `reply-${eventId}-${Date.now()}`,
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
        agentClass: 'unknown',
        kindBadge: '',
        senderName: '你',
      });
    }

    const primaryPendingEvent = this.getPrimaryPendingEvent(messages);
    this.setData({
      chatMessages: messages,
      primaryPendingEvent,
      hasPrimaryPendingEvent: !!primaryPendingEvent,
      dockReplyText: '',
    });
    setTimeout(() => this.fetchDetail(), 1500);
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
        agentClass: 'unknown',
        kindBadge: '',
        senderName: '你',
      });
    }
    const primaryPendingEvent = this.getPrimaryPendingEvent(messages);
    this.setData({ chatMessages: messages, primaryPendingEvent, hasPrimaryPendingEvent: !!primaryPendingEvent }, () => {
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
      agentClass: 'unknown',
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

    const localStatusId = 'local-command-status-' + Date.now();
    const messages = [...this.data.chatMessages, {
      id: localStatusId,
      type: 'system',
      side: 'left',
      content: '已发送，等待电脑端接收...',
      displayTime: this.formatTime(new Date().toISOString()),
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
      eventId: localStatusId,
      accent: 'neutral',
      agentClass: 'unknown',
      kindBadge: '',
      senderName: '',
    } as ChatMessage];

    this.setData({
      commandText: '',
      canSendCommand: false,
      chatMessages: messages,
      scrollToId: 'msg-' + localStatusId,
    });
    wx.showToast({ title: '已发送，等待电脑端接收', icon: 'none', duration: 1500 });
  },

  chooseInputOption(e: any) {
    const eventId = e.currentTarget.dataset.id;
    const value = e.currentTarget.dataset.value || '';
    if (!eventId || !value) return;
    this.replyToInput(eventId, value);
  },

  chooseSheetInputOption(e: any) {
    const eventId = e.currentTarget.dataset.id;
    const value = e.currentTarget.dataset.value || '';
    if (!eventId || !value) return;
    this.replyToInput(eventId, value);
    this.closeApprovalSheet();
  },

  replyToInput(eventId: string, text: string) {
    app.sendWs({
      type: 'approval_response',
      payload: { sessionId: this.data.sessionId, eventId, decision: 'reply', message: text },
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
      decisionText: this.getDecisionText('reply'),
      canApprove: false,
      eventId,
      accent: 'neutral',
      agentClass: 'unknown',
      kindBadge: '',
      senderName: '你',
    });
    const primaryPendingEvent = this.getPrimaryPendingEvent(messages);
    this.setData({ chatMessages: messages, primaryPendingEvent, hasPrimaryPendingEvent: !!primaryPendingEvent, scrollToId: 'msg-' + replyId });
    setTimeout(() => this.fetchDetail(), 1500);
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

  formatInputContent(data: any): string {
    const lines: string[] = [];
    if (data.summary) lines.push(String(data.summary));
    const questions = Array.isArray(data.questions) ? data.questions : [];
    for (const q of questions) {
      const text = q?.text || q?.question || q?.prompt || q?.label;
      if (text && !lines.includes(String(text))) lines.push(String(text));
      const options = Array.isArray(q?.options) ? q.options : [];
      for (const opt of options) {
        const label = typeof opt === 'string' ? opt : opt?.label || opt?.value || opt?.name;
        const desc = typeof opt === 'object' ? opt?.description : '';
        if (label) lines.push(desc ? `- ${label}: ${desc}` : `- ${label}`);
      }
    }
    return lines.join('\n') || 'Agent 需要你的选择';
  },

  extractInputOptions(questions: any[]): { label: string; value: string; description?: string }[] {
    const first = questions.find((q) => Array.isArray(q?.options));
    if (!first) return [];
    return first.options.map((opt: any) => {
      if (typeof opt === 'string') return { label: opt, value: opt };
      return {
        label: String(opt?.label || opt?.value || opt?.name || ''),
        value: String(opt?.value || opt?.id || opt?.label || ''),
        description: opt?.description ? String(opt.description) : undefined,
      };
    }).filter((opt: any) => opt.label && opt.value);
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

function agentColorClass(agentType?: string): 'claude' | 'codex' | 'opencode' | 'unknown' {
  if (agentType === 'codex') return 'codex';
  if (agentType === 'opencode') return 'opencode';
  if (agentType === 'claude-code' || agentType === 'claude-code-hook') return 'claude';
  return 'unknown';
}
