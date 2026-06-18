import { createApi } from '../../services/api';
import { getServerUrl, getContentKey, getKeyId, getDeviceId, getE2EStatus, getE2EState, setE2EStatus, setE2EState } from '../../services/storage';
import { getSubscription, type UsageSnapshot } from '../../services/subscription';
import { ensureUserToken } from '../../services/auth';
import { decryptEventPayload, encryptCommandPayload, generateUUID } from '../../utils/crypto';

const app = getApp<any>();

interface LocalCommandMessage {
  id: string;
  content: string;
  createdAt: string;
}

/** Module-level cache for decrypted event bodies. Decryption is deterministic
 *  + idempotent, so caching across re-polls is safe. */
const decryptedEventCache = new Map<string, Record<string, any>>();
const decryptionFailureLogged = new Set<string>();
const localCommandCacheBySession = new Map<string, LocalCommandMessage[]>();
let fetchDetailSeq = 0;

function localCommandStorageKey(sessionId: string): string {
  return `codekey_local_commands_${sessionId}`;
}

function loadLocalCommandMessages(sessionId: string): LocalCommandMessage[] {
  if (!sessionId) return [];
  const cached = localCommandCacheBySession.get(sessionId);
  if (cached) return cached;
  try {
    const stored = tt.getStorageSync(localCommandStorageKey(sessionId));
    if (Array.isArray(stored)) {
      const messages = stored
        .filter((item: any) => item && typeof item.id === 'string' && typeof item.content === 'string' && typeof item.createdAt === 'string')
        .slice(-50);
      localCommandCacheBySession.set(sessionId, messages);
      return messages;
    }
  } catch (err) {
    console.warn('[session-detail] load local commands failed:', err);
  }
  return [];
}

function saveLocalCommandMessages(sessionId: string, messages: LocalCommandMessage[]): void {
  if (!sessionId) return;
  const trimmed = messages.slice(-50);
  localCommandCacheBySession.set(sessionId, trimmed);
  try {
    tt.setStorageSync(localCommandStorageKey(sessionId), trimmed);
  } catch (err) {
    console.warn('[session-detail] save local commands failed:', err);
  }
}

/** Decrypt all encrypted events in-place. Mirrors Telegram SessionDetailPage's
 *  decryptEvents — see plan §5.3 / §5.4.
 *
 *  Behavior:
 *    - sealed_payload missing                  → leave event untouched (legacy plaintext)
 *    - data.encryption_error === true          → leave as-is (PC fail-closed placeholder)
 *    - encryption_version unknown              → leave + log once
 *    - no contentKey / deviceId                → leave + log once
 *    - decrypt throws                          → leave + log once
 *    - decrypt succeeds                        → merge decrypted body into event.data
 */
async function decryptRawEvents(events: any[]): Promise<any[]> {
  const contentKey = getContentKey();
  const deviceId = getDeviceId();
  // === DIAGNOSTIC ===
  console.log('[decryptRawEvents] contentKey present:', !!contentKey, 'len:', contentKey?.length);
  console.log('[decryptRawEvents] deviceId:', deviceId);
  console.log('[decryptRawEvents] storedKeyId:', getKeyId());
  console.log('[decryptRawEvents] events count:', events.length);
  for (const ev of events.slice(0, 3)) {
    console.log('[decryptRawEvents] event sample:', JSON.stringify({
      id: ev.id, type: ev.type, has_sealed: !!ev.sealed_payload,
      key_id: ev.key_id, encryption_version: ev.encryption_version,
    }));
  }
  if (!contentKey || !deviceId) return events;

  const storedKeyId = getKeyId();
  const out = events.map((event) => ({ ...event }));
  const tasks: Promise<void>[] = [];

  for (const event of out) {
    if (!event.sealed_payload || !event.key_id) continue;

    // Phase 4C: detect keyId mismatch — PC rotated keys, phone has stale key
    if (storedKeyId && event.key_id !== storedKeyId) {
      if (!decryptionFailureLogged.has(event.id)) {
        console.warn('[session-detail] stale keyId: event.key_id=', event.key_id, 'stored=', storedKeyId);
        decryptionFailureLogged.add(event.id);
      }
      event.data = { ...(event.data ?? {}), e2eKeyStale: true };
      continue;
    }
    if (event.encryption_version !== 1) {
      if (!decryptionFailureLogged.has(event.id)) {
        console.warn('[session-detail] unknown encryption_version', event.encryption_version, 'for event', event.id);
        decryptionFailureLogged.add(event.id);
      }
      continue;
    }
    const data = (event.data ?? {}) as Record<string, any>;
    if (data.encryption_error === true) continue;

    const cached = decryptedEventCache.get(event.id);
    if (cached) {
      event.data = cached;
      continue;
    }

    const sealed = event.sealed_payload as string;
    const aadFields = {
      v: 1,
      keyId: event.key_id as string,
      deviceId,
      sessionId: event.session_id as string,
      eventId: (data.clientEventId as string) || (event.id as string),
      eventType: event.type as string,
    };

    tasks.push(
      decryptEventPayload(sealed, data, contentKey, aadFields)
        .then((merged) => {
          decryptedEventCache.set(event.id, merged);
          event.data = merged;
        })
        .catch((err) => {
          if (!decryptionFailureLogged.has(event.id)) {
            console.error('[session-detail] decrypt failed for event', event.id, err);
            decryptionFailureLogged.add(event.id);
          }
          event.data = { ...(event.data ?? {}), e2eKeyStale: true };
        }),
    );
  }

  if (tasks.length > 0) await Promise.all(tasks);
  return out;
}

/** Returns a localized placeholder for events whose body the phone can't read. */
function getEncryptedPlaceholder(data: any): string | null {
  if (data?.e2eKeyStale === true) return '加密内容不可用（密钥已更新，请重新配对手机）';
  if (data?.encryption_error === true) return '加密内容不可用（桌面端加密失败）';
  if (data?.encrypted === true) return '加密内容不可用';
  return null;
}

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

    if (/^#{1,6}\s+/.test(line)) {
      flushList();
      const hMatch = line.match(/^(#{1,6})\s+(.*)$/);
      if (hMatch) {
        const level = hMatch[1].length;
        out.push(`<h${level}>${escapeHtml(hMatch[2])}</h${level}>`);
      }
      continue;
    }

    if (/^[-*_]{3,}$/.test(line)) {
      flushList();
      out.push('<hr>');
      continue;
    }

    if (/^[-*+]\s+/.test(line)) {
      if (!inList || listType !== 'ul') { flushList(); out.push('<ul>'); inList = true; listType = 'ul'; }
      out.push(`<li>${escapeHtml(line.replace(/^[-*+]\s+/, ''))}</li>`);
      continue;
    }

    if (/^\d+\.\s+/.test(line)) {
      if (!inList || listType !== 'ol') { flushList(); out.push('<ol>'); inList = true; listType = 'ol'; }
      out.push(`<li>${escapeHtml(line.replace(/^\d+\.\s+/, ''))}</li>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      flushList();
      out.push(`<blockquote>${escapeHtml(line.replace(/^>\s?/, ''))}</blockquote>`);
      continue;
    }

    if (/^\|[\s:-]+\|$/.test(line)) {
      flushList();
      continue;
    }

    if (/^\|.*\|$/.test(line)) {
      flushList();
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.length === 0) continue;
      if (!out.some(l => /^<table/.test(l))) {
        out.push('<table cellpadding="6" cellspacing="0" style="width:100%;border-collapse:collapse;margin:12rpx 0;font-size:24rpx">');
        out.push('<thead><tr>');
        for (const c of cells) {
          out.push(`<th style="background:#f5f5f4;font-weight:700;padding:8rpx 12rpx;border:1rpx solid #d1d5db;text-align:left">${escapeHtml(c)}</th>`);
        }
        out.push('</tr></thead><tbody>');
      } else {
        out.push('<tr>');
        for (const c of cells) {
          out.push(`<td style="padding:8rpx 12rpx;border:1rpx solid #d1d5db">${escapeHtml(c)}</td>`);
        }
        out.push('</tr>');
      }
      continue;
    }

    if (line) {
      flushList();
      let html = escapeHtml(line)
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>');
      out.push(`<p>${html}</p>`);
    } else if (out.length > 0 && !out[out.length - 1].startsWith('<') && !out[out.length - 1].startsWith('</')) {
      flushList();
    }
  }

  flushList();
  if (inCode) out.push('</code></pre>');
  if (out.some(l => /^<table/.test(l)) && !out.some(l => /<\/table>/.test(l))) {
    out.push('</table>');
  }

  return out.join('\n');
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  contentHtml?: string;
  displayTime: string;
  typeLabel: string;
  isTaskComplete: boolean;
  isCommandStarted?: boolean;
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
}

Page({
  data: {
    sessionId: '',
    session: null as any,
    events: [] as any[],
    chatMessages: [] as ChatMessage[],
    localCommandMessages: [] as LocalCommandMessage[],
    replyTexts: {} as Record<string, string>,
    commandText: '',
    canSendCommand: false,
    wsConnected: false,
    deviceOnline: false,
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
    e2eStatus: 'disabled' as 'enabled' | 'stale' | 'disabled',
    quotaState: 'hidden' as 'hidden' | 'normal' | 'approaching' | 'exhausted',
    quotaPercent: 0,
    usage: null as UsageSnapshot | null,
  },

  onLoad(query: any) {
    const id = query.id || '';
    let viewportHeight = 600;
    try {
      viewportHeight = tt.getSystemInfoSync().windowHeight || 600;
    } catch {}
    this.setData({ sessionId: id, _viewportHeight: viewportHeight });
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

  scrollToBottom() {
    this.setData({ scrollToId: '' }, () => {
      tt.nextTick(() => {
        this.setData({ scrollToId: 'timeline-bottom', scrollTop: Date.now() });
      });
    });
  },

  subscribeWs() {
    // Guard against duplicate registration (e.g. hot-reload in dev IDE)
    this.unsubscribeWs();
    // Bound closures for proper cleanup
    this._onEventPushBound = (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
        this.fetchDetail({ scrollToEventId: payload.eventId });
      }
    };
    this._onSessionDeactivatedBound = (payload: any) => {
      if (payload.sessionId === this.data.sessionId) {
        tt.showToast({ title: '会话已取消关联', icon: 'none', duration: 2000 });
        setTimeout(() => tt.navigateBack(), 1500);
      }
    };
    this._onWsConnectedBound = () => {
      this.setData({ wsConnected: true });
      this.fetchDetail();
    };
    this._onWsDisconnectedBound = () => {
      this.setData({ wsConnected: false, deviceOnline: false });
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
      tt.showToast({ title, icon: 'none', duration: 2000 });
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

    app.onWsEvent('event_push', this._onEventPushBound);
    app.onWsEvent('event_resolved', this._onEventResolvedBound);
    app.onWsEvent('session_deactivated', this._onSessionDeactivatedBound);
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
    if (!!app.globalData.deviceOnline !== this.data.deviceOnline) {
      this.setData({ deviceOnline: !!app.globalData.deviceOnline });
    }
  },

  unsubscribeWs() {
    if (this._onEventResolvedBound) app.offWsEvent('event_resolved', this._onEventResolvedBound);
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
      await ensureUserToken();
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
    const seq = ++fetchDetailSeq;
    try {
      const api = createApi(getServerUrl());
      const [session, rawEventsRaw] = await Promise.all([
        api.getSession(this.data.sessionId),
        api.getSessionEvents(this.data.sessionId),
      ]);

      // Plan §5.3 / §5.4: decrypt sealed_payload events before downstream
      // logic touches them. Legacy plaintext events pass through untouched.
      const rawEvents = await decryptRawEvents(rawEventsRaw);
      if (seq !== fetchDetailSeq) return;

      // Phase 4C: compute E2E status from the latest sealed event only.
      // Old historical events with a prior keyId do NOT pollute the status.
      {
        const ck = getContentKey();
        let status: 'enabled' | 'stale' | 'disabled';
        let latestSealed: any;
        if (!ck) { status = 'disabled'; }
        else {
          latestSealed = rawEvents
            .filter((ev: any) => ev.sealed_payload)
            .sort((a: any, b: any) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
          status = latestSealed && latestSealed.data?.e2eKeyStale === true ? 'stale' : 'enabled';
        }
        this.setData({ e2eStatus: status });
        if (status === 'stale') {
          setE2EState({ state: 'stale', localKeyId: getKeyId(), lastServerKeyId: latestSealed?.key_id ?? null });
        } else {
          setE2EStatus(status);
        }
      }

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
    const cachedLocalCommands = loadLocalCommandMessages(this.data.sessionId);
    if ((this.data.localCommandMessages || []).length !== cachedLocalCommands.length) {
      this.setData({ localCommandMessages: cachedLocalCommands });
    }
    const localCommandMap = new Map<string, LocalCommandMessage>();
    for (const message of cachedLocalCommands) localCommandMap.set(message.id, message);
    for (const message of (this.data.localCommandMessages || [])) localCommandMap.set(message.id, message);
    const localEvents = Array.from(localCommandMap.values())
      .map((message: LocalCommandMessage) => ({
        id: message.id,
        type: 'user_prompt',
        created_at: message.createdAt,
        data: {
          type: 'user_prompt',
          prompt: message.content,
          summary: message.content,
          timestamp: message.createdAt,
          localOnly: true,
        },
      }));
    const sorted = [...rawEvents, ...localEvents].sort((a, b) => {
      if (a.created_at !== b.created_at) {
        return a.created_at < b.created_at ? -1 : 1;
      }
      const priority: Record<string, number> = {
        user_prompt: 0,
        command_started: 1,
        approval_required: 2,
        task_complete: 3,
        session_idle: 4,
      };
      return (priority[this.effectiveEventType(a)] ?? 5) - (priority[this.effectiveEventType(b)] ?? 5);
    });
    const messages: ChatMessage[] = [];
    const seenClientEventIds = new Set<string>();
    let lastUserPrompt = '';
    let lastCommandStarted = false;
    let pendingCommandStarted: ChatMessage | null = null;
    const flushPendingCommandStarted = () => {
      if (!pendingCommandStarted) return;
      messages.push(pendingCommandStarted);
      pendingCommandStarted = null;
    };

    for (const e of sorted) {
      const clientEventId = e.data?.clientEventId;
      if (clientEventId && clientEventId.startsWith('oc-hist:')) {
        if (seenClientEventIds.has(clientEventId)) continue;
        seenClientEventIds.add(clientEventId);
      }
      const time = this.formatTime(e.created_at);
      const command = e.data?.command || '';
      const summary = e.data?.summary || e.data?.command || '';
      const summaryShort = e.data?.summaryShort || '';
      const output = e.data?.output || '';
      const eventAgentType = e.data?.agent || e.data?.agentType || e.agent || e.agent_type;
      const agentName = this.chatAgentName(eventAgentType);
      const agentClass = agentColorClass(eventAgentType || this.data.session?.agent_type || this.data.session?.metadata?.runtime);
      const effectiveType = this.effectiveEventType(e);

      // Dedup consecutive user_prompt events with identical content
      if (effectiveType === 'user_prompt') {
        lastCommandStarted = false;
        // Plan §5.3: when sealed_payload couldn't be decrypted, data only has
        // allowlist fields. Render placeholder instead of empty bubble.
        const placeholder = getEncryptedPlaceholder(e.data);
        const prompt = placeholder ?? (e.data?.prompt || e.data?.summary || '');
        if (prompt === lastUserPrompt && e.data?.localOnly !== true) continue;
        lastUserPrompt = prompt;
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
          agentClass: 'unknown',
          kindBadge: '',
          senderName: '你',
        });
        flushPendingCommandStarted();
        continue;
      }

      if (e.type === 'error') {
        flushPendingCommandStarted();
        lastCommandStarted = false;
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
        flushPendingCommandStarted();
        lastCommandStarted = false;
        messages.push({
          id: e.id + '-sys',
          type: 'system',
          side: 'left',
          content: '等待指令中...',
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
        if (lastCommandStarted) continue;
        lastCommandStarted = true;
        const startedMessage: ChatMessage = {
          id: e.id,
          type: 'ai',
          side: 'left',
          content: '正在处理...',
          displayTime: time,
          typeLabel: '',
          isTaskComplete: false,
          isCommandStarted: true,
          command: '',
          summary: '正在处理...',
          risk_level: '',
          riskText: '',
          pending: false,
          decision: '',
          decisionText: '',
          canApprove: false,
          eventId: e.id,
          accent: 'neutral',
          agentClass,
          kindBadge: '',
          senderName: agentName,
        };
        if (messages[messages.length - 1]?.eventId && messages[messages.length - 1]?.type === 'user') {
          messages.push(startedMessage);
        } else {
          pendingCommandStarted = startedMessage;
        }
        continue;
      }

      if (e.type === 'task_complete') {
        flushPendingCommandStarted();
        lastCommandStarted = false;
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
          kindBadge: '已完成',
          senderName: agentName,
        });
        continue;
      }

      if (e.type === 'approval_required') {
        flushPendingCommandStarted();
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
          kindBadge: e.pending ? '审批中' : (this.getDecisionText(e.decision) || '已完成'),
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
        flushPendingCommandStarted();
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
          summary: e.data?.summary || '需要你的选择',
          risk_level: e.risk_level || 'medium',
          riskText: '',
          pending: e.pending,
          decision: e.decision || '',
          decisionText: !e.pending ? this.getDecisionText(e.decision) : '',
          canApprove: false,
          eventId: e.id,
          accent,
          agentClass,
          kindBadge: e.pending ? '待选择' : (this.getDecisionText(e.decision) || '已完成'),
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
    }

    flushPendingCommandStarted();
    this.appendMissingLocalCommands(messages);
    if (messages.length > 0) {
      const pushedIdx = scrollToEventId
        ? messages.findIndex((m: ChatMessage) => m.eventId === scrollToEventId && m.type === 'ai')
        : -1;
      // Auto-scroll only when:
      // 1. A specific scrollToEventId was requested (new event push)
      // 2. User is near the bottom (not scrolled up reading history)
      const shouldAutoScroll = pushedIdx !== -1 || !this.data._userScrolledUp;

      const primaryPendingEvent = this.getPrimaryPendingEvent(messages);
      const pendingState = {
        primaryPendingEvent,
        hasPrimaryPendingEvent: !!primaryPendingEvent,
      };

      if (shouldAutoScroll) {
        const targetId = pushedIdx !== -1
          ? 'msg-' + messages[pushedIdx].id
          : 'timeline-bottom';
        this.setData({ chatMessages: messages, scrollToId: '', ...pendingState }, () => {
          tt.nextTick(() => {
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

  appendMissingLocalCommands(messages: ChatMessage[]) {
    const cachedLocalCommands = loadLocalCommandMessages(this.data.sessionId);
    const localCommands = [...cachedLocalCommands, ...(this.data.localCommandMessages || [])];
    if (localCommands.length === 0) return;

    const existingIds = new Set(messages.map((message) => message.id));

    for (const local of localCommands) {
      if (existingIds.has(local.id)) continue;
      messages.push({
        id: local.id,
        type: 'user',
        side: 'right',
        content: local.content,
        displayTime: this.formatTime(local.createdAt),
        typeLabel: '',
        isTaskComplete: false,
        command: '',
        summary: local.content,
        risk_level: '',
        riskText: '',
        pending: false,
        decision: '',
        decisionText: '',
        canApprove: false,
        eventId: local.id,
        accent: 'neutral',
        agentClass: 'unknown',
        kindBadge: '',
        senderName: '你',
      });
    }
  },

  getPrimaryPendingEvent(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.type === 'ai' && msg.pending) return msg;
    }
    return null;
  },

  effectiveEventType(event: any): string {
    if (event?.type === 'user_prompt' || event?.data?.type === 'user_prompt' || event?.data?.role === 'user' || event?.role === 'user') {
      return 'user_prompt';
    }
    return event?.type || '';
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
      this.scrollToBottom();
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

    this.setData({ chatMessages: messages, replyTexts }, () => this.scrollToBottom());
    setTimeout(() => this.fetchDetail(), 1500);
  },

  // ── Command input ──

  onCommandInput(e: any) {
    const val = e.detail.value;
    this.setData({ commandText: val, canSendCommand: val.trim() !== '' });
  },

  async sendCommand() {
    const text = this.data.commandText.trim();
    if (!text) {
      tt.showToast({ title: '请输入指令', icon: 'none' });
      return;
    }
    if (!app.globalData.wsConnected) {
      tt.showToast({ title: '未连接服务器', icon: 'none' });
      return;
    }
    if (!this.data.deviceOnline) {
      tt.showToast({ title: '设备离线，无法发送指令', icon: 'none' });
      return;
    }
    if (!this.data.session?.status || this.data.session.status !== 'active') {
      tt.showToast({ title: '会话未处于活跃状态', icon: 'none' });
      return;
    }

    const contentKeyHex = getContentKey();
    const keyId = getKeyId();
    const deviceId = getDeviceId();

    const sentAt = new Date().toISOString();
    const commandId = generateUUID();
    const localCommandId = `local-command-${commandId}`;
    let payload: Record<string, unknown>;

    if (contentKeyHex && keyId && deviceId) {
      const e2eState = getE2EState();
      if (e2eState.state === 'stale') {
        const sameSession = e2eState.lastToastSessionId === this.data.sessionId;
        if (sameSession && Date.now() - e2eState.lastToastAt < 30_000) {
          return;
        }
        setE2EState({ state: 'stale', localKeyId: keyId, lastToastAt: Date.now(), lastToastSessionId: this.data.sessionId });
        tt.showToast({ title: 'E2E 密钥已过期，请在电脑上重新配对', icon: 'none' });
        return;
      }
      try {
        const envelope = await encryptCommandPayload(
          text, contentKeyHex, keyId, deviceId, this.data.sessionId, commandId,
        );
        payload = {
          sessionId: this.data.sessionId,
          action: 'write_stdin',
          sealed_command: envelope.sealed_command,
          command_id: envelope.command_id,
          key_id: envelope.key_id,
          encryption_version: envelope.encryption_version,
        };
      } catch (err) {
        console.error('[sendCommand] encryption failed, dropping command:', err);
        tt.showToast({ title: '加密失败，无法发送指令', icon: 'none' });
        return;
      }
    } else {
      payload = { sessionId: this.data.sessionId, action: 'write_stdin', data: text };
    }

    app.sendWs({
      type: 'command',
      payload,
    });

    const localCommandMessages = [
      ...loadLocalCommandMessages(this.data.sessionId),
      { id: localCommandId, content: text, createdAt: sentAt },
    ].slice(-50);
    saveLocalCommandMessages(this.data.sessionId, localCommandMessages);
    const messages = [...this.data.chatMessages, {
      id: localCommandId,
      type: 'user',
      side: 'right',
      content: text,
      displayTime: this.formatTime(sentAt),
      typeLabel: '',
      isTaskComplete: false,
      command: '',
      summary: text,
      risk_level: '',
      riskText: '',
      pending: false,
      decision: '',
      decisionText: '',
      canApprove: false,
      eventId: localCommandId,
      accent: 'neutral',
      agentClass: 'unknown',
      kindBadge: '',
      senderName: '你',
    } as ChatMessage];

    this.setData({
      localCommandMessages,
      commandText: '',
      canSendCommand: false,
      chatMessages: messages,
      _userScrolledUp: false,
      scrollToId: '',
    }, () => this.scrollToBottom());
    tt.showToast({ title: '已发送，等待电脑端接收', icon: 'none', duration: 1500 });
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
    this.setData({ chatMessages: messages, primaryPendingEvent, hasPrimaryPendingEvent: !!primaryPendingEvent }, () => this.scrollToBottom());
    setTimeout(() => this.fetchDetail(), 1500);
  },

  // ── Navigation ──

  goBack() {
    tt.navigateBack();
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
    return lines.join('\n') || '需要你的选择';
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
  'claude-code': 'Claude 编程',
  'claude-code-hook': 'Claude 编程',
  'codex': 'Codex 编程',
  'opencode': 'OpenCode 编程',
};

const AGENT_CHAT_NAMES: Record<string, string> = {
  'claude-code': 'Claude 编程',
  'claude-code-hook': 'Claude 编程',
  'codex': 'Codex 编程',
  'opencode': 'OpenCode 编程',
};

function agentDisplayName(agentType?: string): string {
  if (!agentType) return 'VS Code 会话';
  return AGENT_DISPLAY_NAMES[agentType] || agentType;
}

function agentChatName(agentType?: string): string {
  if (!agentType) return '编程助手';
  return AGENT_CHAT_NAMES[agentType] || agentType;
}

function agentColorClass(agentType?: string): 'claude' | 'codex' | 'opencode' | 'unknown' {
  if (agentType === 'codex') return 'codex';
  if (agentType === 'opencode') return 'opencode';
  if (agentType === 'claude-code' || agentType === 'claude-code-hook') return 'claude';
  return 'unknown';
}
