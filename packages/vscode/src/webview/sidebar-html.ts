import type { SessionResponse, EventResponse } from '../api/client.js';
import type { AgentDef } from '../agents/registry.js';
import type { BridgeState } from '../services/bridge-status.js';
import { FEISHU_APP_ID_CONST } from '../constants.js';

export interface PendingApprovalItem {
  id: string;
  serverEventId?: string;
  agentType?: string;
  command: string;
  summary: string;
  toolName: string;
  agent: string;
  risk: string;
  serverSessionId: string;
}

export interface PairingState {
  code: string;
  method: 'code' | 'qr';
  platform: 'wechat' | 'feishu' | 'telegram';
  status: 'idle' | 'waiting' | 'paired' | 'error';
  statusText: string;
  expiresAt: number;
  pairUrl?: string;
  contentKeyHex?: string;
  keyId?: string;
}

export interface SubscriptionInfo {
  tier: 'free' | 'trial' | 'paid';
  plan: string | null;
  expiresAt: string | null;
  usage: { used: number; limit: number; period: string } | null;
}

export interface PrivacyInfo {
  summary: { forwarded: number; blocked: number; sanitized: number; totalFindings: number };
  recentEntries: {
    timestamp: string;
    source: string;
    action: string;
    sanitized: boolean;
    blocked: boolean;
    payloadPreview: string;
    eventType?: string;
    displayText?: string;
    previewKind?: 'content' | 'summary' | 'raw';
    findingCount: number;
    payloadLength: number;
    blockedPaths?: string[];
  }[];
}

export interface HistoryPolicyEntry {
  key: string;
  policy: string;
  updatedAt: number;
}

export interface SidebarState {
  deviceStatus: 'unpaired' | 'paired' | 'offline';
  deviceId?: string;
  phoneName: string;
  bridge: BridgeState;
  agents: (AgentDef & {
    runtimeStatus: 'active' | 'idle' | 'unavailable';
    statusLine?: string;
    lastMessage?: string;
    integrationStatus?: 'enabled' | 'not_found';
    canInstall?: boolean;
  })[];
  pendingApprovals: PendingApprovalItem[];
  sessions: SessionResponse[];
  events: Record<string, EventResponse[]>;
  claudeSessions: ClaudeSessionItem[];
  relayUrl?: string;
  deviceSecret?: string;
  feishuAppId?: string;
  pairing?: PairingState;
  pairingPlatform?: string;
  lang?: string;
  subscription?: SubscriptionInfo;
  privacy?: PrivacyInfo;
  historyPolicies?: HistoryPolicyEntry[];
}

export interface ClaudeSessionItem {
  sessionId: string;
  title: string;
  cwd: string;
  transcriptPath?: string;
  createdAt?: string;
  updatedAt: string;
  attached?: boolean;
  canDetach?: boolean;
  /** Set to true for Codex resume sessions */
  isCodexSession?: boolean;
  /** Set to true for OpenCode sessions */
  isOpenCodeSession?: boolean;
  serverSessionId?: string;
  /** True when this Codex session has been resumed */
  resumed?: boolean;
  /** Transient sync button state controlled by the extension host */
  syncStatus?: 'syncing';
}

// ── Helpers ──────────────────────────────────────────────
/** Simple i18n: returns Chinese when lang starts with zh */
function i18n(lang: string | undefined, en: string, zh: string): string { return lang && lang.indexOf("zh") === 0 && zh ? zh : en; }

function h(s: string | undefined | null): string {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + '…';
}

function formatTime(iso: string): string {
  if (!iso) return '';
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

function dot(cls: string): string {
  const pulse = cls.includes('pulse') ? ' class="pulse"' : '';
  return `<span class="dot ${cls}"${pulse}></span>`;
}

function tag(text: string, cls: string): string {
  return `<span class="tag ${cls}">${text}</span>`;
}

// ── Section renderers ────────────────────────────────────

function renderBrandHeader(): string {
   return `<div class="brand">
    <div class="brand-name">Code<span class="brand-em">Key</span></div>
    <div class="brand-sub">A I &nbsp;C o d i n g &nbsp;R e m o t e</div>
  </div>`;
}

export function renderDeviceContent(state: SidebarState): string {
  const serverConnected = state.bridge.relay === 'connected';
  const serverDot = dot(serverConnected ? 'green' : 'red');
  const serverLabel = serverConnected ? i18n(state.lang, "Online", "已连接") : i18n(state.lang, "Offline", "未连接");
  const hasPhone = state.deviceStatus !== 'unpaired';
  const mpOnline = state.deviceStatus === 'paired' && state.bridge.mpOnline;
  const mpDot = dot(mpOnline ? 'green' : 'dim-green');
  const mpLabel = mpOnline
    ? i18n(state.lang, "Online", "已连接")
    : hasPhone
      ? i18n(state.lang, "Paired (background)", "已配对（后台）")
      : '';
  return `<div class="row" style="cursor:pointer" data-action="relayReconnect" title="Click to reconnect"><span class="row-label">${i18n(state.lang, "Server", "服务器")}</span><span class="row-val">${serverDot}${serverLabel}</span></div>
    ${mpLabel ? `<div class="row"><span class="row-label">${i18n(state.lang, "Phone", "移动端")}</span><span class="row-val">${mpDot}${mpLabel}</span></div>` : ''}`;
}

function renderDevice(state: SidebarState): string {
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
        ${i18n(state.lang, "Device", "设备")}
      </span>
    </div>
    <div id="deviceContent">${renderDeviceContent(state)}</div>
  </div>`;
}

/** Per-agent active dot color. Inactive uses neutral gray. */
const AGENT_DOT_CLASS: Record<string, string> = {
  'claude-code': 'orange',
  'codex-cli': 'white',
  'opencode': 'purple',
};

export function renderAgentsContent(state: SidebarState): string {
  if (state.agents.length === 0) return `<div class="empty-state">${i18n(state.lang, 'No agents configured', '无代理配置')}</div>`;
  return state.agents.map(a => {
    const isActive = a.runtimeStatus === 'active';
    const activeColor = AGENT_DOT_CLASS[a.id] || 'green';
    const dotClass = isActive ? `${activeColor} pulse` : 'gray';
    // Determine display: "已连接" if the tool itself is installed/available in VS Code,
    // regardless of hook/plugin integration status
    let modeHtml: string;
    if (a.runtimeStatus === 'unavailable') {
      modeHtml = i18n(state.lang, 'Not installed', '未安装');
    } else {
      modeHtml = i18n(state.lang, 'Connected', '已连接');
    }
    return `<div class="agent-item">
      <div class="agent-title-row">
        <span class="agent-name">${h(a.name)}</span>
        ${dot(dotClass)}
      </div>
      <div class="agent-mode">${modeHtml}</div>
      ${a.lastMessage ? `<div class="agent-last">${h(a.lastMessage)}</div>` : ''}
    </div>`;
  }).join('');
}

function renderAgents(state: SidebarState): string {
  const active = state.agents.filter(a => a.runtimeStatus === 'active').length;
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8z"/><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/></svg>
        ${i18n(state.lang, "Agents", "编程助手")}
      </span>
      <span class="badge${active > 0 ? ' green' : ''}" id="agentsBadge">${active} ${i18n(state.lang, "active", "活跃")}</span>
    </div>
    <div id="agentsContent">${renderAgentsContent(state)}</div>
  </div>`;
}

export function renderApprovalsContent(state: SidebarState): string {
  const pending = state.pendingApprovals;
  if (pending.length === 0) return '<div class="empty-state">No pending approvals</div>';

  const groups: Record<string, { agent: string; agentType: string; items: typeof pending; ts: string }> = {};
  for (const a of pending) {
    if (!groups[a.serverSessionId]) {
      const s = state.sessions.find(s => s.id === a.serverSessionId);
      groups[a.serverSessionId] = { agent: a.agent, agentType: a.agentType || '', items: [], ts: s?.last_active_at || s?.created_at || '' };
    }
    groups[a.serverSessionId].items.push(a);
  }

  const agentColorClass: Record<string, string> = {
    'claude-code': 'c-orange', 'claude-code-hook': 'c-orange',
    'codex': 'c-green', 'opencode': 'c-blue',
  };

  return Object.entries(groups).map(([sid, g]) => {
    const cls = agentColorClass[g.agentType] || 'c-orange';
    return `<div class="approval-session ${cls}">
      <div class="approval-header">
        <span class="approval-agent ${cls}">${h(g.agent)}</span>
      ${g.items.map(item => {
        const rCls = item.risk === 'high' || item.risk === 'critical' ? 'risk-high' : item.risk === 'medium' ? 'risk-medium' : 'risk-low';
        const showCmd = item.toolName === 'Bash' && item.command !== item.summary;
        return `<div class="approval-item">
          <div class="approval-body">
            <span class="approval-summary">${h(item.summary)}</span>
            ${item.toolName ? `<span class="approval-tool">${h(item.toolName)}</span>` : ''}
            ${showCmd ? `<span class="approval-cmd">${h(item.command)}</span>` : ''}
          </div>
          <span class="risk ${rCls}">${h(item.risk)}</span>
        </div>`;
      }).join('')}
    </div>
 `;
  }).join('');
}

function renderApprovals(state: SidebarState): string {
  const pending = state.pendingApprovals;
  const hasPending = pending.length > 0;
  // Aggregate counts by agent type
  const agentColorClass: Record<string, string> = {
    'claude-code': 'c-orange', 'claude-code-hook': 'c-orange',
    'codex': 'c-green', 'opencode': 'c-blue',
  };
  const agentCounts: Record<string, number> = {};
  for (const a of pending) {
    const key = a.agentType || 'claude-code';
    agentCounts[key] = (agentCounts[key] || 0) + 1;
  }
  const badgesHtml = hasPending ? Object.entries(agentCounts).map(([type, count]) =>
    `<span class="agent-badge ${agentColorClass[type] || 'c-orange'}">${count}</span>`
  ).join('') : '';

  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        ${i18n(state.lang, 'Approvals', '审批卡')}
      </span>
      <span class="approval-badges" id="approvalsBadge">${badgesHtml}</span>
    </div>
    <div id="approvalsContent">${renderApprovalsContent(state)}</div>
  </div>`;
}

export function renderPrivacyContent(state: SidebarState): string {
  const p = state.privacy;
  if (!p) {
    return '<div class="empty-state">' + i18n(state.lang, 'Privacy pipeline not available', '隐私管道未就绪') + '</div>';
  }
  const s = p.summary;
  const hasFindings = s.totalFindings > 0;
  return `<div class="privacy-summary">
    <div class="privacy-row">
      <span class="privacy-pill privacy-pill-clickable" data-action="showPrivacyDetail" data-filter="forwarded">
        ${h(String(s.forwarded))} ${i18n(state.lang, 'fwd', '已发')}
      </span>
      <span class="privacy-pill${hasFindings ? ' privacy-pill-warn' : ''} privacy-pill-clickable" data-action="showPrivacyDetail" data-filter="sanitized">
        ${h(String(s.sanitized))} ${i18n(state.lang, 'sanitized', '脱敏')}
      </span>
      <span class="privacy-pill${s.blocked > 0 ? ' privacy-pill-block' : ''} privacy-pill-clickable" data-action="showPrivacyDetail" data-filter="blocked">
        ${h(String(s.blocked))} ${i18n(state.lang, 'blocked', '拦截')}
      </span>
    </div>
    ${hasFindings ? `<div class="privacy-row"><span class="privacy-findings">${h(String(s.totalFindings))} ${i18n(state.lang, 'secrets redacted', '个秘密已擦除')}</span></div>` : ''}
  </div>`;
}

export function renderPrivacyDetailContent(state: SidebarState, filter: string): string {
  const p = state.privacy;
  if (!p) return '';
  const entries = p.recentEntries;
  const filtered = filter === 'all' ? entries : entries.filter(e => e.action === filter);
  const actionLabels: Record<string, string> = {
    forwarded: i18n(state.lang, 'Forwarded', '已发'),
    blocked: i18n(state.lang, 'Blocked', '已拦截'),
    sanitized: i18n(state.lang, 'Sanitized', '已脱敏'),
    redacted_path: i18n(state.lang, 'Path Redacted', '路径已擦除'),
  };
  const sourceLabels: Record<string, string> = {
    approval: i18n(state.lang, 'Approval', '审批'),
    transcript: i18n(state.lang, 'Transcript', '转录'),
    history: i18n(state.lang, 'History', '历史'),
    command: i18n(state.lang, 'Command', '命令'),
  };
  const backText = i18n(state.lang, 'Back', '返回');
  const emptyText = i18n(state.lang, 'No events', '无记录');
  const filterLabel = filter === 'all' ? i18n(state.lang, 'All Events', '全部记录') : (actionLabels[filter] || filter);
  let entriesHtml: string;
  if (filtered.length === 0) {
    entriesHtml = `<div class="sd-empty">${emptyText}</div>`;
  } else {
    entriesHtml = filtered.slice().reverse().map(e => {
      const src = sourceLabels[e.source] || e.source;
      const act = actionLabels[e.action] || e.action;
      const eventType = e.eventType || '';
      const eventClass = eventType.replace(/[^a-z0-9_-]/gi, '') || 'event';
      const eventLabel = eventType ? eventTypeLabel(eventType, state.lang) : '';
      const previewText = e.previewKind === 'summary'
        ? i18n(state.lang, 'Content hidden by Summary mode', '摘要模式已隐藏正文')
        : (e.displayText || e.payloadPreview || '');
      const previewClass = e.previewKind === 'summary' ? ' preview-summary' : '';
      const preview = previewText ? h(truncate(previewText, 300)) : '';
      const ts = e.timestamp ? formatTime(e.timestamp) : '';
      const blockedPaths = e.blockedPaths && e.blockedPaths.length > 0
        ? `<div class="sd-event-blocked">${i18n(state.lang, 'Blocked paths', '拦截路径')}: ${h(e.blockedPaths.join(', '))}</div>`
        : '';
      return `<div class="sd-event">
        <div class="sd-event-header">
          <span class="privacy-tag ${e.action}">${h(act)}</span>
          ${eventLabel ? `<span class="sd-event-type ${h(eventClass)}">${eventLabel}</span>` : ''}
          <span class="sd-event-source">${h(src)}</span>
          <span class="sd-event-ts">${h(ts)}</span>
          <span class="sd-event-len">${h(String(e.payloadLength))}B</span>
        </div>
        ${preview ? `<div class="sd-event-data preview-line${previewClass}">${preview}</div>` : ''}
        ${blockedPaths}
      </div>`;
    }).join('');
  }
  return `<div class="sd-header">
    <button class="sd-back" data-action="hidePrivacyDetail">&#9664; ${backText}</button>
    <span class="sd-title">${h(filterLabel)}</span>
  </div>
  <div class="session-scroll" style="max-height:300px">${entriesHtml}</div>`;
}

function renderPrivacy(state: SidebarState): string {
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
        ${i18n(state.lang, 'Privacy', '隐私')}
      </span>
    </div>
    <div id="privacyContent">${renderPrivacyContent(state)}</div>
  </div>`;
}

const HISTORY_AGENTS: { key: string; label: string; labelZh: string }[] = [
  { key: '*', label: 'All agents', labelZh: '全局策略' },
  { key: 'claude-code-hook', label: 'Claude Code', labelZh: 'Claude Code' },
  { key: 'codex', label: 'Codex', labelZh: 'Codex' },
  { key: 'opencode', label: 'OpenCode', labelZh: 'OpenCode' },
];

export function renderHistoryPolicyContent(state: SidebarState): string {
  const policies = state.historyPolicies || [];
  const lookup = new Map<string, HistoryPolicyEntry>();
  for (const p of policies) lookup.set(p.key, p);

  const optLabels: Record<string, string> = {
    off: i18n(state.lang, 'Off', '关闭'),
    recent: i18n(state.lang, 'Full', '会话过程'),
    sanitized: i18n(state.lang, 'Summary', '任务摘要'),
  };
  const opts = ['off', 'recent', 'sanitized'];
  const defaultPolicy = lookup.get('*')?.policy || 'off';

  return HISTORY_AGENTS.map(({ key, label, labelZh }) => {
    const entry = lookup.get(key);
    const current = key === '*' ? (entry?.policy || 'off') : (entry?.policy || defaultPolicy);
    const labelText = i18n(state.lang, label, labelZh);
    return `<div class="hp-row" data-hp-key="${key}">
      <span class="hp-label">${labelText}</span>
      <div class="hp-controls">
        <select class="hp-select" data-hp-key="${key}">
          ${opts.map(o => `<option value="${o}"${o === current ? ' selected' : ''}>${optLabels[o]}</option>`).join('')}
        </select>
      </div>
    </div>`;
  }).join('');
}

function renderHistoryPolicy(state: SidebarState): string {
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
        ${i18n(state.lang, 'Event Share', '事件共享')}
      </span>
    </div>
    <div id="historyPolicyContent">${renderHistoryPolicyContent(state)}</div>
  </div>`;
}

export function renderSessionsContent(state: SidebarState): string {
  const items = state.claudeSessions.filter(s => s && s.sessionId).slice().sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });
  const agents = state.agents || [];
  const tabsHtml = '<div class="agent-tabs" id="agentTabs">'
    + '<span class="agent-tab active" data-tab="all">All</span>'
    + agents.map(a => `<span class="agent-tab" data-tab="${h(a.id)}">${h(a.name)}</span>`).join('')
    + '</div>';
  if (items.length === 0) return tabsHtml + '<div class="empty-state">' + i18n(state.lang, 'No local sessions', '无本地会话') + '</div>';
  const maxVisible = 5;
  const itemsHtml = items.map((s, i) => {
    const hidden = i >= maxVisible;
    const extraCls = hidden ? ' session-hidden' : '';
    return _sessionItemHtml(state.lang, s, extraCls);
  }).join('');
  const more = Math.max(0, items.length - maxVisible);
  const moreText = more > 0 ? '+ ' + more + ' ' + i18n(state.lang, 'more', '更多') : '';
  return tabsHtml
    + '<div class="session-scroll">'
    + itemsHtml
    + (moreText ? '<div class="session-show-more" id="sessionShowMore"><button class="btn-ghost btn-sm" data-action="toggleShowMoreSessions">' + moreText + '</button></div>' : '')
    + '</div>';
}

export function renderSessionDetailContent(state: SidebarState, serverSessionId: string): string {
  const events = state.events[serverSessionId] || [];
  const session = state.sessions.find(s => s.id === serverSessionId);
  const claudeSession = state.claudeSessions.find(s => s.serverSessionId === serverSessionId);
  const title = claudeSession ? h(_displayTitle(claudeSession)) : session?.metadata?.title ? h(String(session.metadata.title)) : h(serverSessionId.slice(0, 8));
  const agentType = session?.agent_type || 'unknown';
  const lang = state.lang;
  const backText = i18n(lang, 'Back', '返回');
  const emptyText = i18n(lang, 'No shared events yet', '暂无已分享事件');

  let eventHtml: string;
  if (events.length === 0) {
    eventHtml = `<div class="sd-empty">${emptyText}</div>`;
  } else {
    eventHtml = events.slice().reverse().map((ev) => {
      const et = h(ev.type);
      const summary = ev.data?.summary || ev.data?.prompt || ev.data?.command || ev.data?.output || '';
      const summaryText = h(summary.slice(0, 300));
      const ts = ev.created_at ? formatTime(ev.created_at) : '';
      const typeLabel = eventTypeLabel(ev.type, lang);
      return `<div class="sd-event">
        <div class="sd-event-header">
          <span class="sd-event-type ${et}">${typeLabel}</span>
          <span class="sd-event-ts">${h(ts)}</span>
        </div>
        <div class="sd-event-data">${summaryText || '<span style="color:#50506e">(no content)</span>'}</div>
      </div>`;
    }).join('');
  }

  return `<div class="sd-header">
    <button class="sd-back" data-action="hideSessionDetail">&#9664; ${backText}</button>
    <span class="sd-title" title="${title}">${title}</span>
    <span class="sd-agent">${h(agentType)}</span>
  </div>
  <div class="session-scroll" style="max-height:300px">${eventHtml}</div>`;
}

function eventTypeLabel(type: string, lang?: string): string {
  switch (type) {
    case 'user_prompt': return i18n(lang, 'Prompt', '提示');
    case 'task_complete': return i18n(lang, 'Complete', '完成');
    case 'approval_required': return i18n(lang, 'Approval', '审批');
    case 'command_started': return i18n(lang, 'Command', '命令');
    default: return type;
  }
}

function _sessionItemHtml(lang: string | undefined, s: any, extraCls: string): string {
      const isAttached = s.attached;
      const sid = s.sessionId;
      const syncStatus = s.syncStatus || (s.syncing === true ? 'syncing' : '');
      const isSyncing = syncStatus === 'syncing';
      const btnCls = isSyncing ? 'btn-syncing' : isAttached ? 'btn-attached' : '';
      const btnText = isSyncing ? '' : isAttached ? i18n(lang, 'Unsync', '取消同步') : i18n(lang, 'Sync', '同步');
      const agent = s.isOpenCodeSession ? 'opencode' : s.isCodexSession ? 'codex' : 'claude-code';
      const isCodex = s.isCodexSession ? 'true' : 'false';
      const isOpenCode = s.isOpenCodeSession ? 'true' : '';
      const title = _displayTitle(s);
      const serverSessionId = s.serverSessionId || '';
      return `<div class="session-item${extraCls}" data-sid="${h(sid)}" data-agent="${agent}">
        <div class="session-title-row">
          <span class="session-title-click" data-action="togglePreview" data-session-id="${h(sid)}" data-server-session-id="${h(serverSessionId)}" data-iscodex="${isCodex}" data-isopencode="${isOpenCode}">
            <span class="chevron">&#9654;</span>
            <span class="session-title" title="${h(title)}">${h(truncate(title, 60))}</span>
          </span>
          <button class="btn btn-sm ${btnCls}" data-action="toggleAttachClaudeSession" data-session-id="${h(sid)}" data-title="${h(title)}" data-server-session-id="${h(serverSessionId)}" data-attached="${isAttached ? 'true' : 'false'}"${s.isCodexSession ? ' data-iscodex="true"' : ''}${s.isOpenCodeSession ? ' data-isopencode="true"' : ''}${syncStatus ? ' disabled' : ''}>${isSyncing ? '<span class="spinner"></span>' : btnText}</button>
        </div>
        <div class="session-meta">
          <span class="session-cwd">${h(truncate(s.cwd || '', 50))}</span>
          <span class="session-ts">${h(formatTime(s.updatedAt))}</span>
        </div>
        <div class="preview" id="preview-${h(sid)}"></div>
      </div>`;
}

function _displayTitle(s: any): string {
  var t = s.title || s.sessionId || '';
  if (s.isOpenCodeSession) {
    // OpenCode often returns the session ID as the title
    if (!s.title || /^ses_/.test(t) || t === s.sessionId) return 'OpenCode session';
    return t;
  }
  if (/^[0-9a-f]{8}/.test(t) && t.length >= 8) return 'Codex session';
  return t;
}

function renderClaudeSessions(state: SidebarState): string {
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        ${i18n(state.lang, 'Local Sessions', '本地会话')}
      </span>
      <span class="refresh-status" id="sessionsRefreshStatus"></span>
      <button class="btn-ghost btn-sm" data-action="refreshClaudeSessions" title="Refresh" style="font-size:11px;padding:2px 6px">↻</button>
    </div>
    <div id="sessionsContent">${renderSessionsContent(state)}</div>
  </div>`;
}

export function renderSubscribe(state: SidebarState): string {
  const sub = state.subscription;
  let planLabel = 'AI Coding Remote';
  let planClass = '';
  if (sub) {
    if (sub.tier === 'paid') {
      const pn = sub.plan === 'yearly' ? 'Annual' : 'Monthly';
      planLabel = `Pro · ${pn}`;
      if (sub.expiresAt) {
        const days = Math.max(0, Math.ceil((new Date(sub.expiresAt).getTime() - Date.now()) / 86400000));
        if (days > 0 && days <= 3) planClass = 'sub-expiring';
      }
      planClass += ' sub-paid';
    } else if (sub.tier === 'trial') {
      const days = sub.expiresAt
        ? Math.max(0, Math.ceil((new Date(sub.expiresAt).getTime() - Date.now()) / 86400000))
        : 14;
      planLabel = `Trial · ${days} day${days !== 1 ? 's' : ''}`;
      planClass = ' sub-trial';
      if (days <= 3) planClass += ' sub-expiring';
    } else if (sub.usage) {
      planLabel = `Free · ${sub.usage.used}/${sub.usage.limit}`;
      planClass = sub.usage.used >= sub.usage.limit ? ' sub-exhausted'
        : sub.usage.used >= sub.usage.limit * 0.8 ? ' sub-approaching'
        : ' sub-free';
    }
  }
  const qqHtml = `<div class="qq-group-row"><span class="qq-icon">QQ</span> <a class="qq-link" href="https://qm.qq.com/q/ryWvbgYpNY" target="_blank">827453239</a></div>`;
  // Upgrade-to-Pro CTA: only show to free-tier users (paid/trial users
  // already see their plan or trial countdown in the sub-row above).
  // Link still points to the external shop page.
  const upgradeCtaHtml = sub && sub.tier === 'free'
    ? `<a class="upgrade-cta" href="https://pay.ldxp.cn/shop/6T7QKRTE" target="_blank">${i18n(state.lang, 'Upgrade to Pro', '升级 Pro')}</a>`
    : '';
  const notPairedHint = state.deviceStatus !== 'paired'
    ? `<div class="redeem-hint">${i18n(state.lang, 'Pair a device first, then redeem your code here.', '请先配对设备，配对成功后再来此输入兑换码激活。')}</div>`
    : '';
  const expandedHtml = `<div class="redeem-panel" id="redeemPanel">
    <a class="purchase-link" href="https://pay.ldxp.cn/shop/6T7QKRTE" target="_blank">${i18n(state.lang, 'Purchase →', '购买 →')}</a>
    ${notPairedHint}
    <div class="redeem-row">
      <input class="redeem-input" id="redeemInput" placeholder="CK-XXXX-XXXX-XXXX" maxlength="19" spellcheck="false" ${state.deviceStatus !== 'paired' ? 'disabled' : ''} />
      <button class="redeem-btn" data-action="redeemCode" ${state.deviceStatus !== 'paired' ? 'disabled' : ''}>${i18n(state.lang, 'Redeem', '兑换')}</button>
    </div>
    <div class="redeem-status" id="redeemStatus"></div>
  </div>`;
  return `<div class="footer" id="subscriptionFooter">${qqHtml}${upgradeCtaHtml}<div class="sub-row" data-action="toggleRedeem"><span class="sub-label${planClass}">${planLabel}</span><span class="expand-icon">▸</span></div>${expandedHtml}</div>`;
}

// ── Pairing card ─────────────────────────────────────────

type QrCodeInstance = {
  addData(text: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
};

type QrCodeConstructor = new (typeNumber: number, errorCorrectLevel: number) => QrCodeInstance;

const QRCode = require('qrcode-terminal/vendor/QRCode') as QrCodeConstructor;
const QRErrorCorrectLevel = require('qrcode-terminal/vendor/QRCode/QRErrorCorrectLevel') as { L: number };

/**
 * Render a standards-compliant QR matrix as SVG so wx.scanCode can decode it.
 */
function generateQrSvg(text: string, size: number = 200): string {
  if (!text) return '';

  const qrcode = new QRCode(-1, QRErrorCorrectLevel.L);
  qrcode.addData(text);
  qrcode.make();

  // Render to SVG with the required quiet zone.
  const N = qrcode.getModuleCount();
  const margin = 4;
  const totalModules = N + margin * 2;
  const scale = size / totalModules;
  const rects: string[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (qrcode.isDark(r, c)) {
        const x = (c + margin) * scale;
        const y = (r + margin) * scale;
        rects.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${scale.toFixed(1)}" height="${scale.toFixed(1)}" fill="#000"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">
<rect width="${size}" height="${size}" fill="#fff"/>
${rects.join('\n')}
</svg>`;
}

function hexToBase64Url(hex: string): string {
  return Buffer.from(hex, 'hex')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function renderPairingContent(state: SidebarState): string {
  const p = state.pairing;
  const isWaiting = p?.status === 'waiting';
  const hasLocalCreds = !!state.deviceId && !!state.deviceSecret;
  const isPaired = state.deviceStatus === 'paired' && !isWaiting;
  const codeDigits = p?.code || '--------';
  const codeExpires = p?.expiresAt || 0;
  const platform = p?.platform || state.pairingPlatform || 'telegram';
  // undefined or empty string → fallback to built-in constant
  const rawFeishuAppId = state.feishuAppId;
  const feishuAppId = (rawFeishuAppId === undefined || rawFeishuAppId === '')
    ? FEISHU_APP_ID_CONST
    : rawFeishuAppId;
  const hasFeishu = !!feishuAppId;
  const hasPartialCreds = !!(state.deviceId || state.deviceSecret);
  const wechatName = i18n(state.lang, 'WeChat', '微信');
  const feishuName = i18n(state.lang, 'Feishu', '飞书');
  const telegramName = i18n(state.lang, 'Telegram', 'Telegram');
  const platName = platform === 'wechat' ? wechatName
    : platform === 'feishu' ? feishuName
    : telegramName;
  const hasCode = !!p?.code;

  // When paired, collapse to a compact connected card (no code/QR clutter)
  if (isPaired) {
    return `<div class="paired-compact">
      <div class="paired-row">
        <div class="paired-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="paired-text">
          <div class="paired-title">${i18n(state.lang, 'Paired', '已配对')}</div>
          <div class="paired-sub">${platName}</div>
        </div>
        <button class="btn btn-sm btn-attached" data-action="unpairDevice" style="margin-left:auto">${i18n(state.lang, 'Unpair', '取消配对')}</button>
      </div>
    </div>`;
  }

  // Generate QR SVGs
  const qrSize = 200;
  const wechatQrSvg = p?.pairUrl && p?.platform === 'wechat' ? generateQrSvg(p.pairUrl, qrSize)
    : p?.code && !p?.pairUrl ? generateQrSvg(p.code, qrSize) : '';
  const feishuQrSvg = p?.pairUrl && p?.platform === 'feishu'
    ? generateQrSvg(p.pairUrl, qrSize)
    : '';
  const tgDeepLink = p?.code
    ? (p?.contentKeyHex && p?.keyId
        ? `https://t.me/CodekeyAiBot?startapp=ck_${hexToBase64Url(p.contentKeyHex)}_${p.code}`
        : `https://t.me/CodekeyAiBot?startapp=${p.code}`)
    : '';
  const tgQrSvg = tgDeepLink ? generateQrSvg(tgDeepLink, qrSize) : '';
  const tgKeyInfo = platform === 'telegram' && hasCode && p?.contentKeyHex
    ? `<div class="tg-key-info" style="margin-top:8px">
      <div class="guide-step" style="font-size:11px;color:#16a34a;font-weight:600">${i18n(state.lang, 'E2E encryption key embedded in QR — auto-paired', 'E2E 加密密钥已嵌入二维码，扫码自动配对')}</div>
    </div>` : '';

  // Platform toggle — all neutral, no default selection
  const platToggleHtml = `<div class="platform-toggle">
    <div class="plat-opt" data-platform="telegram">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.127-.007.352-.032.483L15.29 14.49c-.049.21-.181.404-.34.52-.19.14-.433.205-.693.152-.025-.005-.052-.01-.076-.016l-2.012-.613-1.09 1.273c-.12.142-.282.219-.458.216a.526.526 0 0 1-.046-.002l.414-2.235s3.745-3.39 3.907-3.557c.018-.018.044-.054-.012-.063-.055-.01-.125.022-.125.022l-5.03 3.243-1.82-.606c-.38-.12-.4-.386-.083-.586l7.203-4.26c.168-.1.37-.14.566-.142z"/></svg>
      Telegram
    </div>
    <div class="plat-opt" data-platform="wechat">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM17.18 9.418c-2.256 0-4.288.842-5.73 2.22-1.393 1.33-2.114 3.117-1.963 4.977.157 1.941 1.497 3.605 3.51 4.582.84.408 1.805.65 2.876.65.44 0 .87-.04 1.286-.118l1.448.847a.26.26 0 0 0 .127.04.224.224 0 0 0 .221-.224c0-.054-.022-.11-.037-.163l-.297-1.124a.448.448 0 0 1 .162-.506C20.125 19.155 21 17.58 21 15.78c0-3.36-3.053-6.362-3.82-6.362zm-5.222 3.137a.733.733 0 1 1 0 1.466.733.733 0 0 1 0-1.466zm3.676 0a.733.733 0 1 1 0 1.466.733.733 0 0 1 0-1.466z"/></svg>
      WeChat
    </div>
    <div class="plat-opt${!hasFeishu ? ' disabled' : ''}" data-platform="feishu">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M4.5 2A2.5 2.5 0 0 0 2 4.5v15A2.5 2.5 0 0 0 4.5 22h15a2.5 2.5 0 0 0 2.5-2.5v-15A2.5 2.5 0 0 0 19.5 2h-15zM8 7a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2h-2V9h-4v2H8V7zm-1 5h10v2h-4v2h-2v-2H7v-2z"/></svg>
      Feishu${!hasFeishu ? '<span class="plat-badge">Coming Soon</span>' : ''}
    </div>
  </div>`;

  // Combined view: code digits + QR side by side (or stacked)
  const codeHtml = `<div class="code-display-wrap">
    <div class="code-digits" id="codeDigits" data-expires="${codeExpires}">${h(codeDigits)}</div>
    <div class="code-timer" id="codeTimer">${i18n(state.lang, 'Code expires in ', '配对码')}<span id="countdown">5:00</span>${i18n(state.lang, '', '后过期')}</div>
  </div>`;

  const qrHtml = `<div id="qrVisual" class="qr-visual-wrap">
    ${!hasCode
      ? `<div style="width:${qrSize}px;height:${qrSize}px;display:inline-flex;align-items:center;justify-content:center;color:#50506e;font-size:12px">${i18n(state.lang, 'Generate a code first', '请先生成配对码')}</div>`
      : `<div id="qrTelegram" style="display:${platform === 'telegram' ? 'inline-block' : 'none'}">${tgQrSvg}</div>`
        + `<div id="qrWechat" style="display:${platform === 'wechat' ? 'inline-block' : 'none'}">${wechatQrSvg}</div>`
        + (feishuQrSvg ? `<div id="qrFeishu" style="display:${platform === 'feishu' ? 'inline-block' : 'none'}">${feishuQrSvg}</div>` : '')
    }
  </div>`;

  const actionHtml = `<div class="code-actions">
    <button class="btn btn-sm btn-ghost" data-action="regeneratePairingCode">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
      ${i18n(state.lang, 'Regenerate', '重新生成')}
    </button>
    ${hasPartialCreds ? `<button class="btn btn-sm btn-ghost" data-action="unpairDevice">${i18n(state.lang, 'Reset', '重置')}</button>` : ''}
  </div>`;

  const tgGuide = platform === 'telegram' && hasCode
    ? `<div class="tg-guide">
      <div class="guide-step">1. Scan QR with phone camera or open Telegram</div>
      <div class="guide-step">2. Mini App opens → auto-filled &amp; pairs</div>
      <div class="guide-step">3. Done — no manual entry needed</div>
      ${tgKeyInfo}
    </div>` : '';
  const wechatGuide = platform === 'wechat' && hasCode
    ? `<div class="tg-guide">
      <div class="guide-step">${i18n(state.lang, 'Open WeChat on your phone', '打开手机微信')}</div>
      <div class="guide-step">${i18n(state.lang, 'Search for <strong>CodeKey</strong> mini program', '搜索「<strong>码钥</strong>」小程序')}</div>
      <div class="guide-step">${i18n(state.lang, 'Tap <strong>Scan QR</strong> on the home page to pair', '点击首页「<strong>扫码</strong>」完成配对')}</div>
    </div>` : '';
  const guideHtml = tgGuide || wechatGuide;

  // Hide actions/guide when no code generated yet — platforms auto-generate on click
  return `<div class="pairing-content">
    ${platToggleHtml}
    ${hasCode ? `<div class="pairing-code-area">
      ${codeHtml}
      <div class="pairing-divider"><span>${i18n(state.lang, 'or scan QR', '或扫码')}</span></div>
      ${qrHtml}
      ${guideHtml}
      ${actionHtml}
    </div>` : `<div class="pairing-placeholder">${i18n(state.lang, 'Select a platform above to pair', '选择一个平台开始配对')}</div>`}
  </div>`;
}

function renderPairing(state: SidebarState): string {
  return `<div class="card pairing-card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        ${i18n(state.lang, 'Pairing', '配对')}
      </span>
    </div>
    <div id="pairingContent">${renderPairingContent(state)}</div>
  </div>`;
}

// ── Main render ──────────────────────────────────────────

const NONCE = 'ck2026sid';

export function renderSidebar(state: SidebarState): string {
  return `<!DOCTYPE html>
<html lang="${(state.lang || "") || 'en'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'nonce-${NONCE}'; connect-src http://* https://* ws://* wss://*;">
<style>${STYLES}</style>
</head>
<body>
${renderBrandHeader()}
${renderDevice(state)}
${renderPairing(state)}
${renderAgents(state)}
${renderClaudeSessions(state)}
${renderApprovals(state)}
${renderPrivacy(state)}
${renderHistoryPolicy(state)}
${renderSubscribe(state)}
<script nonce="${NONCE}">
(function() {
  var api = acquireVsCodeApi();
	  var lang = document.documentElement.lang || 'en';
	  function T(en, zh) { return lang.indexOf('zh') === 0 && zh ? zh : en; }
	  api.T = T;

  // Session detail view state
  var _inDetailView = false;
  var _currentDetailServerSessionId = null;
  // Privacy detail view state
  var _inPrivacyDetail = false;

  // Pairing data injected from extension host state
  var PD = ${JSON.stringify({
    relayUrl: state.relayUrl || '',
    deviceId: state.deviceId || '',
    deviceSecret: state.deviceSecret || '',
    pairingStatus: state.pairing?.status || 'idle',
  })};

  // ── Pairing WebSocket ──────────────────────────
  var _pairingWs = null;

  function openPairingWs() {
    if (_pairingWs) return;
    if (!PD.relayUrl || !PD.deviceId || !PD.deviceSecret) return;
    var base = PD.relayUrl.replace(/http/, 'ws');
    var wsUrl = base + '/ws?device_id=' + encodeURIComponent(PD.deviceId) + '&device_secret=' + encodeURIComponent(PD.deviceSecret);
    var ws = new WebSocket(wsUrl);
    _pairingWs = ws;
    ws.addEventListener('message', function(e) {
      try {
        var msg = JSON.parse(typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data));
        if (msg.type === 'pairing_ready') {
          var ps = document.getElementById('pairingStatus');
          if (ps) { ps.textContent = 'Code scanned! Waiting for confirmation...'; ps.className = 'pairing-status waiting'; }
        }
        if (msg.type === 'device_token') {
          var payload = msg.payload || {};
          var token = payload.deviceToken || msg.deviceToken || msg.token;
          var deviceId = payload.deviceId || msg.deviceId;
          api.postMessage({
            action: 'pairedDevice',
            token: token,
            deviceId: deviceId,
            phonePublicKeyHex: payload.phonePublicKeyHex,
            e2eKeyReceived: payload.e2eKeyReceived
          });
          ws.close(); _pairingWs = null;
          var ps = document.getElementById('pairingStatus');
          if (ps) { ps.textContent = 'Paired successfully!'; ps.className = 'pairing-status success'; }
        }
      } catch(e) {}
    });
    ws.addEventListener('close', function() { if (_pairingWs === ws) _pairingWs = null; });
    ws.addEventListener('error', function() { ws.close(); });
  }

  function closePairingWs() {
    if (_pairingWs) { _pairingWs.onclose = null; _pairingWs.close(); _pairingWs = null; }
  }

  // Auto-open pairing WS if pairing in progress (handles re-render reconnect)
  if (PD.pairingStatus === 'waiting') openPairingWs();

  // ── Incremental state update (no full re-render) ──
  function updateHeaderTag(id, text, cls) {
    var el = document.getElementById(id);
    if (el) { el.textContent = text; el.className = 'tag ' + cls; }
  }
  // Cache last HTML per section — skip swap when unchanged to preserve
  // user-opened previews / scroll position / active tab state.
  var _lastHtml = { deviceContent: '', pairingContent: '', agentsContent: '', approvalsContent: '', sessionsContent: '', subscriptionHtml: '', privacyContent: '', historyPolicyContent: '' };
  function swap(id, html) {
    if (html === undefined) return false;
    if (_lastHtml[id] === html) return false;
    var el = document.getElementById(id);
    if (!el) return false;
    el.innerHTML = html;
    _lastHtml[id] = html;
    return true;
  }
  /** Like swap() but replaces the entire element via outerHTML.
   *  Used when the HTML includes the container itself (e.g. <div id="...">).
   *  The id MUST be in _lastHtml so it deduplicates correctly. */
  function replaceById(id, html) {
    if (html === undefined) return false;
    if (_lastHtml[id] === html) return false;
    var el = document.getElementById(id);
    if (!el) return false;
    el.outerHTML = html;
    _lastHtml[id] = html;
    return true;
  }

  // ── Messages from extension host ───────────────
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'stateUpdate') {
      var d = e.data;
      // Update content sections (skip if unchanged)
      swap('deviceContent', d.deviceHtml);
      swap('pairingContent', d.pairingHtml);
      applySavedPlatform(false);
      swap('agentsContent', d.agentsHtml);
      swap('approvalsContent', d.approvalsHtml);
      if (!_inPrivacyDetail) { swap('privacyContent', d.privacyHtml); }
      swap('historyPolicyContent', d.historyPolicyHtml);
      replaceById('subscriptionFooter', d.subscriptionHtml);
      if (!_inDetailView) { if (swap('sessionsContent', d.sessionsHtml)) applyAgentFilter(); }
      // Update badges
      if (d.agentCount !== undefined) {
        var ab = document.getElementById('agentsBadge');
        if (ab) { ab.textContent = d.agentCount + ' ' + T('active', '活跃'); ab.className = 'badge' + (d.agentCount > 0 ? ' green' : ''); }
      }
      if (d.approvalCount !== undefined) {
        // approvalsBadge is now innerHTML-managed by renderApprovals, so just
        // trigger a re-render by swapping the full card (already done above).
      }
      // Update device status tag
      if (d.deviceStatus !== undefined) {
        var ds = document.getElementById('deviceStatusTag');
        if (ds) {
          var statusText = T(i18n(state.lang, "Online", "在线"), '在线'); var offlineText = T(i18n(state.lang, "Offline", "离线"), '离线'); var unpairedText = T(i18n(state.lang, "Not paired", "未配对"), '未配对'); if (d.deviceStatus === 'paired') { ds.textContent = '● ' + statusText; ds.className = 'tag green'; }
          else if (d.deviceStatus === 'offline') { ds.textContent = '● ' + offlineText; ds.className = 'tag red'; }
          else { ds.textContent = '● ' + unpairedText; ds.className = 'tag orange'; }
        }
      }
      // Update PD so openPairingWs uses fresh data
      if (d.relayUrl !== undefined) PD.relayUrl = d.relayUrl || '';
      if (d.deviceId !== undefined) PD.deviceId = d.deviceId || '';
      if (d.deviceSecret !== undefined) PD.deviceSecret = d.deviceSecret || '';
      if (d.pairingStatus) {
        PD.pairingStatus = d.pairingStatus;
        if (d.pairingStatus === 'waiting') openPairingWs();
        else closePairingWs();
      }
      return;
    }

    if (e.data && e.data.type === 'sessionPreview') {
      var sid = e.data.sessionId;
      var el = document.getElementById('preview-' + sid);
      if (!el) return;
      if (e.data.entries && e.data.entries.length > 0) {
        var agentLabel = e.data.agentLabel || 'Claude';
        var html = '';
        // Show newest first (entries are chronological, iterate backwards)
        for (var i = e.data.entries.length - 1; i >= 0; i--) {
          var entry = e.data.entries[i];
          var isUser = entry.role === 'user';
          // User on right (WeChat style), agent on left
          var side = isUser ? 'right' : 'left';
          var label = isUser ? 'You' : agentLabel;
          var labelCls = isUser ? 'pv-label pv-label-right' : 'pv-label';
          html += '<div class="pv-msg">'
            + '<div class="' + labelCls + '">' + label + '</div>'
            + '<div class="pv-bubble pv-bubble-' + side + '">' + entry.text + '</div>'
            + '</div>';
        }
        el.innerHTML = html;
      } else {
        el.innerHTML = '<div class="preview-empty">No conversation history</div>';
      }
      el.style.display = 'block';
    }

    if (e.data && e.data.type === 'sessionDetail') {
      var sc2 = document.getElementById('sessionsContent');
      if (sc2) { sc2.innerHTML = e.data.html; _inDetailView = true; }
      return;
    }

    if (e.data && e.data.type === 'privacyDetail') {
      var pc = document.getElementById('privacyContent');
      if (pc) {
        pc.innerHTML = e.data.html;
        _lastHtml.privacyContent = e.data.html;
        _inPrivacyDetail = true;
      }
      return;
    }

    if (e.data && e.data.type === 'sessionsRefreshStatus') {
      var status = document.getElementById('sessionsRefreshStatus');
      if (status) status.textContent = e.data.text || '';
    }
  });

  // Pairing method toggle removed — code and QR shown together
  document.addEventListener('click', function(e) {
    // Agent tab filter (Local Sessions card)
    var tab = e.target.closest('.agent-tab');
    if (tab) {
      var tabs = tab.parentElement;
      if (tabs) tabs.querySelectorAll('.agent-tab').forEach(function(t) { t.classList.remove('active'); });
      tab.classList.add('active');
      try { sessionStorage.setItem('agentFilter', tab.dataset.tab); } catch(e) {}
      applyAgentFilter();
      return;
    }
    // Platform toggle — click to switch, auto-generate if no code yet
    var plat = e.target.closest('.plat-opt');
    if (plat) {
      if (plat.classList.contains('disabled')) return;
      var platform = plat.dataset.platform;
      document.querySelectorAll('.plat-opt').forEach(function(p) { p.classList.toggle('active', p.dataset.platform === platform); });
      ['Telegram', 'Wechat', 'Feishu'].forEach(function(p) {
        var el = document.getElementById('qr' + p);
        if (el) el.style.display = p.toLowerCase() === platform ? 'inline-block' : 'none';
      });
      try { sessionStorage.setItem('pairingPlatform', platform); } catch(e) {}
      // Auto-generate pairing code on first platform click (no code yet)
      var codeDigits = document.getElementById('codeDigits');
      var needsCode = !codeDigits || codeDigits.textContent === '--------';
      api.postMessage({ action: needsCode ? 'platformPair' : 'switchPlatform', platform: platform });
      return;
    }
  });

  // Apply current agent filter and per-tab folding
  var _foldExpanded = false;

  function applyAgentFilter() {
    var stored = 'all';
    try { stored = sessionStorage.getItem('agentFilter') || 'all'; } catch(e) {}
    var key = stored;
    var tabs = document.querySelector('#agentTabs');
    if (tabs) {
      tabs.querySelectorAll('.agent-tab').forEach(function(t) {
        t.classList.toggle('active', t.dataset.tab === key);
      });
    }
    var items = document.querySelectorAll('.session-item');
    var matching = [];
    items.forEach(function(it) {
      var ag = it.dataset.agent || 'claude-code';
      var match = (key === 'all') || (ag === key);
      it.classList.remove('session-hidden');
      it.style.display = '';
      if (!match) {
        it.style.display = 'none';
      } else {
        matching.push(it);
      }
    });

    // Per-tab folding
    var maxVisible = 5;
    var overflow = matching.length - maxVisible;
    if (!_foldExpanded) {
      for (var i = 0; i < matching.length; i++) {
        if (i >= maxVisible) matching[i].style.display = 'none';
      }
    }
    var moreBtn = document.getElementById('sessionShowMore');
    if (moreBtn) {
      if (overflow > 0 && !_foldExpanded) {
        moreBtn.style.display = '';
        var b = moreBtn.querySelector('button');
        if (b) b.textContent = '+ ' + overflow + ' more' + (overflow > 1 ? ' sessions' : '');
      } else {
        moreBtn.style.display = 'none';
      }
    }
    if (_foldExpanded && matching.length <= maxVisible) {
      _foldExpanded = false;
    }

    var emptyMsg = document.getElementById('sessionsEmpty');
    var scroll = document.querySelector('#sessionsContent .session-scroll');
    if (matching.length === 0 && scroll && !emptyMsg) {
      var div = document.createElement('div');
      div.id = 'sessionsEmpty';
      div.className = 'empty-state';
      div.textContent = 'No sessions for this agent';
      scroll.appendChild(div);
    } else if (matching.length > 0 && emptyMsg) {
      emptyMsg.remove();
    }
  }

  // Apply saved platform preference on the current DOM
  function applySavedPlatform(syncToProvider) {
    var codeDigits = document.getElementById('codeDigits');
    var hasGeneratedCode = !!codeDigits && codeDigits.textContent !== '--------';
    if (!hasGeneratedCode) {
      document.querySelectorAll('.plat-opt').forEach(function(t) { t.classList.remove('active'); });
      return;
    }
    var saved;
    try { saved = sessionStorage.getItem('pairingPlatform'); } catch(e) {}
    if (!saved) return; // no saved preference, keep all neutral
    // If the saved platform is disabled (Feishu pending approval), fall back to telegram
    var platform = saved;
    var platEl = document.querySelector('.plat-opt[data-platform="' + platform + '"]');
    if (platEl && platEl.classList.contains('disabled')) platform = 'telegram';
    var toggles = document.querySelectorAll('.plat-opt');
    if (toggles.length === 0) return;
    toggles.forEach(function(t) { t.classList.toggle('active', t.dataset.platform === platform); });
    ['Telegram', 'Wechat', 'Feishu'].forEach(function(p) {
      var el = document.getElementById('qr' + p);
      if (el) el.style.display = p.toLowerCase() === platform ? 'inline-block' : 'none';
    });
    // Only sync to provider on user click, not on passive state restoration
    if (syncToProvider) {
      api.postMessage({ action: 'switchPlatform', platform: platform });
    }
  }

  // Restore agent filter on load + after each re-render
  try {
    var savedAg = sessionStorage.getItem('agentFilter');
    if (savedAg) {
      var savedTab = document.querySelector('.agent-tab[data-tab="' + savedAg + '"]');
      if (savedTab) {
        document.querySelectorAll('.agent-tab').forEach(function(t) { t.classList.remove('active'); });
        savedTab.classList.add('active');
        applyAgentFilter();
      }
    }
  } catch(e) {}

  // Restore saved pairing method
  // Restore saved platform preference
  applySavedPlatform(false);

  // Countdown timer (local, based on data-expires timestamp)
  var countdownTimer = setInterval(function() {
    var el = document.getElementById('codeDigits');
    if (!el) return;
    var expiresAt = parseInt(el.dataset.expires || '0');
    if (!expiresAt) {
      var cd = document.getElementById('countdown');
      if (cd) cd.textContent = '5:00';
      return;
    }
    var remaining = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    var m = Math.floor(remaining / 60);
    var s = remaining % 60;
    var cd = document.getElementById('countdown');
    if (cd) {
      cd.textContent = m + ':' + String(s).padStart(2, '0');
      cd.parentElement.className = 'code-timer' + (remaining <= 60 ? ' urgent' : '');
    }
  }, 1000);

  document.addEventListener('click', function(e) {
    var target = e.target instanceof HTMLElement ? e.target.closest('[data-action]') : null;
    if (!target) return;
    var action = target.dataset.action;

    if (action === 'togglePreview') {
      var sid = target.dataset.sessionId;
      // Attached session: navigate to detail view instead of inline preview
      var serverSid = target.dataset.serverSessionId;
      if (serverSid) {
        _inDetailView = true;
        _currentDetailServerSessionId = serverSid;
        var sc = document.getElementById('sessionsContent');
        if (sc) sc.innerHTML = '<div class="session-scroll"><div class="sd-empty">Loading...</div></div>';
        api.postMessage({ action: 'showSessionDetail', sessionId: sid, serverSessionId: serverSid });
        return;
      }
      var el = document.getElementById('preview-' + sid);
      if (!el) return;
      var item = target.closest('.session-item');
      var chevron = item ? item.querySelector('.chevron') : null;
      if (el.style.display === 'block') {
        el.style.display = 'none';
        if (chevron) chevron.textContent = '▶';
      } else {
        el.style.display = 'block';
        if (chevron) chevron.textContent = '▼';
        el.innerHTML = '<div class="preview-empty">Loading...</div>';
        api.postMessage({ action: 'getSessionPreview', sessionId: sid, iscodex: target.dataset.iscodex === 'true', isopencode: target.dataset.isopencode === 'true' });
      }
      return;
    }

    if (action === 'toggleAttachClaudeSession') {
      // Immediately show spinner — avoids "Sync" text lingering before server round-trip
      target.classList.add('btn-syncing');
      target.disabled = true;
      target.innerHTML = '<span class="spinner"></span>';
      api.postMessage({
        action: action,
        sessionId: target.dataset.sessionId,
        attached: target.dataset.attached === 'true',
        title: target.dataset.title || '',
        serverSessionId: target.dataset.serverSessionId || '',
        iscodex: target.dataset.iscodex === 'true',
        isopencode: target.dataset.isopencode === 'true',
      });
      return;
    }

    if (action === 'toggleShowMoreSessions') {
      _foldExpanded = true;
      applyAgentFilter();
      return;
    }

    // Codex resume/stop — pass sessionId from data-session-id
    if (action === 'resumeCodexSession' || action === 'stopCodexResume') {
      api.postMessage({
        action: action,
        sessionId: target.dataset.sessionId,
      });
      return;
    }

    // Unpair: clear sessionStorage before notifying provider
    if (action === 'unpairDevice') {
      try { sessionStorage.removeItem('pairingPlatform'); } catch(e) {}
    }

    // Toggle redeem panel
    if (action === 'toggleRedeem') {
      var panel = document.getElementById('redeemPanel');
      var icon = target.querySelector('.expand-icon');
      if (panel) {
        var isOpen = panel.classList.toggle('open');
        if (icon) icon.classList.toggle('open', isOpen);
        if (isOpen) setTimeout(function() {
          var inp = document.getElementById('redeemInput');
          if (inp) inp.focus();
        }, 100);
      }
      return;
    }

    // Redeem code
    if (action === 'redeemCode') {
      var input = document.getElementById('redeemInput');
      var status = document.getElementById('redeemStatus');
      var btn = target;
      if (!input || !status) return;
      var code = input.value.trim().toUpperCase();
      if (!code) { status.textContent = T('Enter a code', '请输入兑换码'); status.className = 'redeem-status err'; return; }
      btn.disabled = true;
      status.textContent = T('Redeeming...', '兑换中...');
      status.className = 'redeem-status';
      api.postMessage({ action: 'redeemCode', code: code });
      return;
    }

    // Back from session detail to session list
    if (action === 'hideSessionDetail') {
      _inDetailView = false;
      _currentDetailServerSessionId = null;
      // Force a full state push to get fresh sessions + events
      api.postMessage({ action: 'refreshClaudeSessions' });
      return;
    }

    if (action === 'showPrivacyDetail') {
      var filter = target.dataset.filter || 'all';
      _inPrivacyDetail = true;
      var pc = document.getElementById('privacyContent');
      if (pc) {
        var loadingHtml = '<div class="session-scroll"><div class="sd-empty">Loading...</div></div>';
        pc.innerHTML = loadingHtml;
        _lastHtml.privacyContent = loadingHtml;
      }
      api.postMessage({ action: 'showPrivacyDetail', filter: filter });
      return;
    }

    if (action === 'hidePrivacyDetail') {
      _inPrivacyDetail = false;
      _lastHtml.privacyContent = '';
      api.postMessage({ action: 'hidePrivacyDetail' });
      return;
    }

    api.postMessage({ action: action });
  });

  // ── History Policy controls ───────────────────
  document.addEventListener('change', function(e) {
    var target = e.target;
    if (target.classList.contains('hp-select')) {
      var row = target.closest('.hp-row');
      var key = row ? row.dataset.hpKey : '';
      if (!key) return;
      var policy = target.value;
      if (key === '*') {
        document.querySelectorAll('.hp-select').forEach(function(select) {
          if (select instanceof HTMLSelectElement && select.dataset.hpKey !== '*') {
            select.value = policy;
          }
        });
      }
      api.postMessage({ action: 'setHistoryPolicy', key: key, policy: policy });
      return;
    }
  });

  // Listen for redeem result from extension host
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'redeemResult') {
      var status = document.getElementById('redeemStatus');
      var btn = document.querySelector('.redeem-btn');
      if (btn) btn.disabled = false;
      if (!status) return;
      if (e.data.ok) {
        status.textContent = T('Redeemed! Subscription extended.', '兑换成功！订阅已延长。');
        status.className = 'redeem-status ok';
        var inp = document.getElementById('redeemInput');
        if (inp) inp.value = '';
      } else {
        status.textContent = T('Failed: ', '兑换失败：') + e.data.error;
        status.className = 'redeem-status err';
      }
    }
  });

  // Enter key on redeem input
  document.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && document.activeElement === document.getElementById('redeemInput')) {
      var btn = document.querySelector('.redeem-btn');
      if (btn && !btn.disabled) btn.click();
    }
  });
})();
</script>
</body>
</html>`;
}

const STYLES = `
/* ═══════════════════════════════════════════════
   RESET & VARIABLES
   ═══════════════════════════════════════════════ */
*,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
body{
  background:var(--vscode-sideBar-background,#0f0f18);
  color:var(--vscode-editor-foreground,#e8e8f0);
  font-family:var(--vscode-font-family,system-ui,-apple-system,sans-serif);
  font-size:13px;
  line-height:1.5;
  padding:0;
  overflow-x:hidden;
}

/* ═══════════════════════════════════════════════
   BRAND
   ═══════════════════════════════════════════════ */
.brand{
  text-align:center;padding:14px 16px 12px;
  position:relative;
}
.brand::after{
  content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);
  width:40px;height:1px;
  background:linear-gradient(90deg,transparent,var(--vscode-textLink-foreground,#00ffe0),transparent);
}
.brand-name{
  font-family:Georgia,'Times New Roman',serif;
  font-weight:800;font-size:20px;
  letter-spacing:-.01em;
  color:var(--vscode-editor-foreground);
}
.brand-em{
  font-style:italic;font-weight:500;
  color:var(--vscode-textLink-foreground,#00ffe0);
}
.brand-sub{
  font-size:10px;color:var(--vscode-descriptionForeground,#50506e);
  letter-spacing:.15em;text-transform:uppercase;
  margin-top:1px;
}

/* ═══════════════════════════════════════════════
   CARD
   ═══════════════════════════════════════════════ */
.card{
  background:var(--vscode-sideBar-background,#12121e);
  border:1px solid var(--vscode-panel-border,#1e1e2e);
  border-radius:12px;
  margin:0 10px 2px;
  padding:12px 12px 10px;
  transition:border-color .2s;
}
.card + .card{margin-top:2px}
.card-header{
  display:flex;align-items:center;justify-content:space-between;
  margin-bottom:10px;padding-bottom:6px;
  border-bottom:1px solid var(--vscode-panel-border,#1e1e2e);
  position:relative;
}
.card-header::after{
  content:'';position:absolute;bottom:-1px;left:0;
  width:20px;height:1px;
  background:var(--vscode-textLink-foreground,#00ffe0);opacity:.5;
}
.card-label{
  font-size:9px;font-weight:600;text-transform:uppercase;
  letter-spacing:.1em;color:var(--vscode-descriptionForeground,#50506e);
  display:flex;align-items:center;gap:5px;
}
.refresh-status{
  margin-left:auto;
  margin-right:6px;
  font-size:10px;
  color:var(--vscode-descriptionForeground,#50506e);
}
.card-label svg{width:11px;height:11px}

/* ═══════════════════════════════════════════════
   STATUS DOT
   ═══════════════════════════════════════════════ */
.dot{
  display:inline-block;width:6px;height:6px;border-radius:50%;
  margin-right:3px;vertical-align:middle;
  position:relative;flex-shrink:0;
}
.dot.green{background:#2ecc71;box-shadow:0 0 6px rgba(46,204,113,.4)}
.dot.orange{background:#f5a623;box-shadow:0 0 6px rgba(245,166,35,.4)}
.dot.red{background:#f74d4d;box-shadow:0 0 6px rgba(247,77,77,.4)}
.dot.gray{background:#50506e;box-shadow:none}
.dot.dim-green{background:rgba(46,204,113,.35);box-shadow:none}
.dot.white{background:#f0f0f5;box-shadow:0 0 6px rgba(240,240,245,.35)}
.dot.purple{background:#9d6cff;box-shadow:0 0 6px rgba(157,108,255,.4)}
.dot.pulse::after{
  content:'';position:absolute;inset:0;border-radius:50%;
  animation:pulse-dot 2s ease-in-out infinite;
}
@keyframes pulse-dot{
  0%,100%{transform:scale(1);opacity:.6}
  50%{transform:scale(2);opacity:0}
}

/* ═══════════════════════════════════════════════
   TAG / BADGE
   ═══════════════════════════════════════════════ */
.tag{
  display:inline-flex;align-items:center;gap:3px;
  padding:1px 7px;border-radius:99px;font-size:9px;font-weight:500;
  background:var(--vscode-badge-background,#181824);
  color:var(--vscode-badge-foreground,#8888a8);
  white-space:nowrap;
}
.tag.green{background:rgba(46,204,113,.12);color:#2ecc71}
.tag.orange{background:rgba(245,166,35,.12);color:#f5a623}
.tag.red{background:rgba(247,77,77,.12);color:#f74d4d}
.tag.cyan{background:rgba(0,255,224,.1);color:#00ffe0}
.badge{
  display:inline-flex;align-items:center;
  font-size:9px;font-weight:500;
  padding:0 6px;border-radius:99px;height:16px;
  background:var(--vscode-badge-background,#181824);
  color:var(--vscode-badge-foreground,#8888a8);
}
.badge.green{background:rgba(46,204,113,.12);color:#2ecc71}
.badge.orange{background:rgba(245,166,35,.12);color:#f5a623}
.session-hidden{display:none}
.session-show-more{padding:4px 12px;text-align:center}

/* Agent count badges in approval header */
.approval-badges{display:flex;gap:4px;align-items:center}
.agent-badge{
  display:inline-flex;align-items:center;justify-content:center;
  width:18px;height:18px;border-radius:50%;
  font-size:10px;font-weight:700;line-height:1;
}
.agent-badge.c-orange{background:rgba(245,166,35,.15);color:#f5a623}
.agent-badge.c-green{background:rgba(46,204,113,.15);color:#2ecc71}
.agent-badge.c-blue{background:rgba(92,156,245,.15);color:#5c9cf5}
.agent-count-dot{
  display:inline-flex;align-items:center;justify-content:center;
  width:16px;height:16px;border-radius:50%;
  font-size:9px;font-weight:700;line-height:1;margin-right:4px;
}
.agent-count-dot.c-orange{background:rgba(245,166,35,.15);color:#f5a623}
.agent-count-dot.c-green{background:rgba(46,204,113,.15);color:#2ecc71}
.agent-count-dot.c-blue{background:rgba(92,156,245,.15);color:#5c9cf5}
.approval-agent.c-orange{color:#f5a623}
.approval-agent.c-green{color:#2ecc71}
.approval-agent.c-blue{color:#5c9cf5}

/* ═══════════════════════════════════════════════
   ROW
   ═══════════════════════════════════════════════ */
.row{
  display:flex;align-items:center;justify-content:space-between;
  padding:4px 0;gap:8px;
}
.row + .row{border-top:1px solid rgba(255,255,255,.03)}
.row-label{font-size:11px;color:var(--vscode-descriptionForeground,#50506e);flex-shrink:0}
.row-val{font-size:11px;color:var(--vscode-editor-foreground,#8888a8);display:flex;align-items:center}
.section-divider{height:1px;background:rgba(255,255,255,.05);margin:6px 0 8px}

/* ═══════════════════════════════════════════════
   BUTTONS
   ═══════════════════════════════════════════════ */
.btn{
  display:inline-flex;align-items:center;justify-content:center;gap:4px;
  padding:5px 12px;border-radius:5px;
  font-family:var(--vscode-font-family,system-ui);font-size:11px;font-weight:500;
  border:1px solid var(--vscode-panel-border,#1e1e2e);
  background:var(--vscode-button-secondaryBackground,#181824);
  color:var(--vscode-button-secondaryForeground,#8888a8);
  cursor:pointer;transition:all .2s;
  white-space:nowrap;
}
.btn:hover{
  background:var(--vscode-panel-border,#1e1e2e);
  color:var(--vscode-editor-foreground,#e8e8f0);
  border-color:var(--vscode-descriptionForeground,#50506e);
}
.btn:active{transform:scale(.97)}
.btn-primary{
  background:rgba(0,255,224,.08);border-color:rgba(0,255,224,.2);
  color:var(--vscode-textLink-foreground,#00ffe0);
}
.btn-primary:hover{background:rgba(0,255,224,.15);border-color:#00ffe0}
.btn-danger{
  background:rgba(247,77,77,.08);border-color:rgba(247,77,77,.2);
  color:#f74d4d;
}
.btn-danger:hover{background:rgba(247,77,77,.15);border-color:#f74d4d}
.btn-ghost{background:transparent;border-color:transparent;color:var(--vscode-descriptionForeground,#50506e)}
.btn-ghost:hover{background:var(--vscode-button-secondaryBackground,#181824);color:var(--vscode-descriptionForeground,#50506e);border-color:transparent}
.btn-sm{font-size:10px;padding:4px 8px}
.btn-group{display:flex;gap:6px;margin-top:8px;flex-wrap:wrap}

/* ═══════════════════════════════════════════════
   AGENTS
   ═══════════════════════════════════════════════ */
.agent-item{
  padding:6px 0;border-bottom:1px solid rgba(255,255,255,.03);
}
.agent-item:last-child{border-bottom:none;padding-bottom:0}
.agent-item:first-child{padding-top:0}
.agent-title-row{display:flex;align-items:center;gap:6px}
.agent-name{font-size:12px;font-weight:500;color:var(--vscode-editor-foreground);flex:1}
.agent-mode{font-size:10px;color:var(--vscode-descriptionForeground,#50506e);margin-top:2px}
.agent-install{font-size:10px;color:var(--vscode-textLink-foreground,#4fc1ff);cursor:pointer;text-decoration:none}
.agent-install:hover{text-decoration:underline}
.agent-last{
  font-size:10px;color:var(--vscode-descriptionForeground,#50506e);margin-top:2px;
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;
}

/* ═══════════════════════════════════════════════
   APPROVALS
   ═══════════════════════════════════════════════ */
.approval-session{margin-bottom:6px}
.approval-session:last-child{margin-bottom:0}
.approval-header{display:flex;align-items:center;gap:6px;padding:3px 0;font-size:11px}
.approval-agent{color:var(--vscode-editor-foreground);font-weight:500}
.approval-dot{font-size:8px;margin-right:2px}
.approval-item{
  display:flex;align-items:center;justify-content:space-between;gap:6px;
  padding:4px 8px;margin-left:4px;
  border-left:2px solid var(--vscode-badge-background,#333);
  overflow:hidden;
}
.approval-session.c-orange .approval-item{border-left-color:#f5a623}
.approval-session.c-green .approval-item{border-left-color:#2ecc71}
.approval-session.c-blue .approval-item{border-left-color:#5c9cf5}
}
.approval-body{display:flex;align-items:center;gap:6px;flex:1;min-width:0}
.approval-summary{font-size:11px;color:var(--vscode-foreground,#e8e8f0);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.approval-tool{font-size:9px;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-descriptionForeground,#50506e);background:var(--vscode-textBlockQuote-background,#181824);padding:1px 4px;border-radius:2px;flex-shrink:0}
.approval-cmd{font-size:10px;font-family:var(--vscode-editor-font-family,monospace);color:var(--vscode-descriptionForeground,#8888a8);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.risk{
  font-size:8px;padding:0 5px;border-radius:99px;
  font-family:var(--vscode-font-family,system-ui);font-weight:500;flex-shrink:0;
}
.risk-high{background:rgba(247,77,77,.1);color:#f74d4d}
.risk-medium{background:rgba(245,166,35,.1);color:#f5a623}
.risk-low{background:rgba(46,204,113,.08);color:#2ecc71}

/* ═══════════════════════════════════════════════
   SESSIONS
   ═══════════════════════════════════════════════ */
.session-scroll{max-height:340px;overflow-y:auto;overflow-x:hidden}
.session-scroll::-webkit-scrollbar{width:4px}
.session-scroll::-webkit-scrollbar-thumb{background:var(--vscode-panel-border,#1e1e2e);border-radius:4px}
.session-item{padding:6px 0;border-bottom:1px solid rgba(255,255,255,.03)}
.session-item:last-child{border-bottom:none}
.session-item:hover .session-title{color:var(--vscode-textLink-foreground,#00ffe0)}
.session-title-row{display:flex;align-items:center;gap:6px}
.session-title-click{display:flex;align-items:center;gap:6px;cursor:pointer;flex:1;min-width:0;overflow:hidden}
.chevron{font-size:8px;color:var(--vscode-descriptionForeground,#50506e);flex-shrink:0;width:12px;text-align:center;transition:transform .2s}
.chevron.open{transform:rotate(90deg)}
.session-title{
  font-size:11px;font-weight:500;color:var(--vscode-editor-foreground);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;
  transition:color .2s;
}
.session-title-row .btn{flex-shrink:0;min-width:56px}
.btn-attached{
  background:rgba(46,204,113,.1);border-color:#2ecc71;color:#2ecc71;
}
.btn-attached:hover{background:rgba(46,204,113,.2);border-color:#2ecc71}
.btn-syncing{background:rgba(128,128,128,.1);border-color:var(--vscode-panel-border,#1e1e2e);pointer-events:none}
@keyframes spin{to{transform:rotate(360deg)}}
.spinner{display:inline-block;width:12px;height:12px;border:2px solid var(--vscode-descriptionForeground,#50506e);border-top-color:transparent;border-radius:50%;animation:spin .6s linear infinite;vertical-align:middle}
.session-meta{
  display:flex;align-items:center;justify-content:space-between;
  margin-top:2px;padding-left:18px;
}
.session-cwd{font-size:9px;color:var(--vscode-descriptionForeground,#50506e);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.session-ts{font-size:9px;color:var(--vscode-descriptionForeground,#50506e);flex-shrink:0}

/* ═══════════════════════════════════════════════
   PREVIEW
   ═══════════════════════════════════════════════ */
.preview{padding:6px 0 2px 18px;display:none}
.preview-empty{font-size:10px;color:var(--vscode-descriptionForeground,#50506e);text-align:center;padding:8px 0}
.pv-msg{margin-bottom:6px;overflow:hidden}
.pv-label{font-size:9px;font-weight:600;color:var(--vscode-descriptionForeground,#50506e);margin-bottom:1px}
.pv-label-right{text-align:right}
.pv-bubble{display:inline-block;padding:5px 8px;border-radius:5px;font-size:10px;line-height:1.4;white-space:pre-wrap;word-break:break-word;max-width:80%}
.pv-bubble-left{background:var(--vscode-textBlockQuote-background,#181824);color:var(--vscode-descriptionForeground,#8888a8);float:left}
.pv-bubble-right{background:rgba(0,255,224,.08);color:var(--vscode-textLink-foreground,#00ffe0);float:right}

/* ═══════════════════════════════════════════════
   SESSION DETAIL
   ═══════════════════════════════════════════════ */
.sd-header{display:flex;align-items:center;gap:6px;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.05);margin-bottom:6px}
.sd-back{font-size:10px;color:var(--vscode-textLink-foreground,#00ffe0);cursor:pointer;background:none;border:none;padding:2px 6px;border-radius:2px;flex-shrink:0}
.sd-back:hover{background:rgba(255,255,255,.05)}
.sd-title{font-size:11px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
.sd-agent{font-size:9px;color:var(--vscode-descriptionForeground,#50506e);flex-shrink:0}
.sd-empty{font-size:10px;color:var(--vscode-descriptionForeground,#50506e);text-align:center;padding:12px 0}
.sd-event{margin-bottom:4px;padding:4px 6px;border-radius:3px;font-size:10px;line-height:1.4}
.sd-event:hover{background:rgba(255,255,255,.02)}
.sd-event-header{display:flex;align-items:center;gap:6px;margin-bottom:2px}
.sd-event-type{font-weight:600;font-size:9px;text-transform:uppercase;letter-spacing:.03em}
.sd-event-type.user_prompt{color:#2ecc71}
.sd-event-type.task_complete{color:#5c9cf5}
.sd-event-type.approval_required{color:#e2b714}
.sd-event-type.command_started{color:#a855f7}
.sd-event-type.event{color:#8888a8}
.sd-event-ts{font-size:8px;color:var(--vscode-descriptionForeground,#50506e);margin-left:auto}
.sd-event-source{font-size:9px;color:var(--vscode-descriptionForeground,#7878a0);flex-shrink:0}
.sd-event-len{font-size:8px;color:var(--vscode-descriptionForeground,#50506e)}
.sd-event-data{font-size:10px;color:var(--vscode-editor-foreground);white-space:pre-wrap;word-break:break-word;max-height:60px;overflow:hidden}
.sd-event-data.preview-line{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-height:none}
.sd-event-data.preview-summary{color:var(--vscode-descriptionForeground,#7878a0);font-style:italic}
.sd-event-blocked{font-size:9px;color:#f74d4d;margin-top:2px}
.sd-event-data.expanded{max-height:none}
.sd-expand{font-size:8px;color:var(--vscode-textLink-foreground,#00ffe0);cursor:pointer;background:none;border:none;padding:0;margin-top:2px}
.sd-expand:hover{text-decoration:underline}
.sd-event+.sd-event{border-top:1px solid rgba(255,255,255,.03)}

/* ═══════════════════════════════════════════════
   MISC
   ═══════════════════════════════════════════════ */
.empty-state{font-size:11px;color:var(--vscode-descriptionForeground,#50506e);text-align:center;padding:8px 0}
.footer{text-align:center;padding:12px 0 8px;font-size:9px;color:var(--vscode-descriptionForeground,#50506e);letter-spacing:.04em}
.sub-label.sub-paid{color:var(--vscode-terminal-ansiBlue,#3794ff)}
.sub-label.sub-trial{color:var(--vscode-terminal-ansiBlue,#3794ff)}
.sub-label.sub-free{color:var(--vscode-descriptionForeground,#50506e)}
.sub-label.sub-approaching{color:var(--vscode-terminal-ansiYellow,#e2b714)}
.sub-label.sub-exhausted{color:var(--vscode-terminal-ansiRed,#f14c4c)}
.sub-label.sub-expiring{color:var(--vscode-terminal-ansiYellow,#e2b714)}
.upgrade-cta{display:inline-flex;align-items:center;justify-content:center;margin:6px 0 8px;padding:4px 8px;border:1px solid var(--vscode-button-border,rgba(92,156,245,.45));border-radius:4px;background:var(--vscode-button-background,#5c9cf5);color:var(--vscode-button-foreground,#fff);font-size:10px;font-weight:700;letter-spacing:0;text-decoration:none}
.upgrade-cta:hover{background:var(--vscode-button-hoverBackground,#4a8ae8);text-decoration:none}
.sub-row{display:flex;align-items:center;justify-content:center;gap:6px;cursor:pointer}
.sub-row:hover .expand-icon{opacity:1}
.expand-icon{font-size:10px;opacity:0.4;transition:transform .2s,opacity .2s;color:var(--vscode-descriptionForeground,#888)}
.expand-icon.open{transform:rotate(90deg)}
.redeem-panel{display:none;margin-top:6px;padding-top:6px;border-top:1px solid var(--vscode-panel-border,#2a2a3a)}
.redeem-panel.open{display:block}
.purchase-link{display:block;font-size:11px;color:var(--vscode-textLink-foreground,#5c9cf5);margin-bottom:6px;text-decoration:none}
.purchase-link:hover{text-decoration:underline}
.redeem-row{display:flex;gap:4px}
.redeem-input{flex:1;min-width:0;background:var(--vscode-input-background,#1a1a2e);color:var(--vscode-input-foreground,#e8e8f0);border:1px solid var(--vscode-input-border,#333);border-radius:2px;padding:3px 6px;font-size:11px;font-family:monospace;outline:none}
.redeem-input:focus{border-color:var(--vscode-focusBorder,#5c9cf5)}
.redeem-btn{background:var(--vscode-button-background,#5c9cf5);color:var(--vscode-button-foreground,#fff);border:none;border-radius:2px;padding:3px 8px;font-size:11px;cursor:pointer;white-space:nowrap}
.redeem-btn:disabled{opacity:0.5;cursor:default}
.redeem-btn:hover:not(:disabled){background:var(--vscode-button-hoverBackground,#4a8ae8)}
.redeem-status{font-size:10px;margin-top:4px;min-height:1.2em}
.redeem-status.ok{color:var(--vscode-terminal-ansiGreen,#2ecc71)}
.redeem-status.err{color:var(--vscode-terminal-ansiRed,#e74c3c)}
.redeem-hint{text-align:center;font-size:10px;color:var(--vscode-descriptionForeground,#888);margin-bottom:6px;line-height:1.4}
.redeem-input:disabled{opacity:0.4;cursor:not-allowed}
.qq-group-row{display:flex;align-items:center;justify-content:center;gap:4px;font-size:10px;margin-bottom:3px;color:var(--vscode-descriptionForeground,#888)}
.qq-icon{font-size:9px;font-weight:600;background:var(--vscode-badge-background,#333);color:var(--vscode-badge-foreground,#fff);padding:0 3px;border-radius:2px;line-height:1.4}
.qq-number{color:var(--vscode-descriptionForeground,#888)}
.qq-link{color:var(--vscode-textLink-foreground,#5c9cf5);text-decoration:none}
.qq-link:hover{text-decoration:underline}

/* ═══════════════════════════════════════════════
   PAIRING CARD
   ═══════════════════════════════════════════════ */
.pairing-card{
  border-color:rgba(0,255,224,.12);
  background:linear-gradient(135deg,rgba(0,255,224,.02),transparent 60%);
}
.pairing-methods{display:flex;flex-direction:column;gap:8px}
.platform-toggle{display:flex;gap:4px;padding:0 2px 2px}
.pairing-content{display:flex;flex-direction:column;gap:0}
.pairing-placeholder{text-align:center;padding:16px 0;font-size:11px;color:var(--vscode-descriptionForeground,#50506e)}
.pairing-code-area{text-align:center}
.pairing-divider{display:flex;align-items:center;gap:8px;margin:10px 0 8px;font-size:10px;color:var(--vscode-descriptionForeground,#50506e)}
.pairing-divider::before,.pairing-divider::after{content:'';flex:1;height:1px;background:var(--vscode-panel-border,#1e1e2e)}
.code-display-wrap{text-align:center;padding:8px 0 4px}
.code-digits{
  font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;font-weight:700;
  font-size:26px;letter-spacing:.08em;
  color:var(--vscode-textLink-foreground,#00ffe0);
  text-shadow:0 0 30px rgba(0,255,224,.12);
  line-height:1.2;
  word-break:break-all;
}
@keyframes codePop{0%{transform:scale(.8);opacity:0}50%{transform:scale(1.05)}100%{transform:scale(1);opacity:1}}
.code-digits.pop{animation:codePop .3s cubic-bezier(.4,0,.2,1)}
.code-timer{font-size:11px;color:var(--vscode-descriptionForeground,#50506e);margin-top:4px;font-variant-numeric:tabular-nums}
.code-timer .urgent{color:var(--accent-red,#f74d4d)}
.code-actions{display:flex;align-items:center;justify-content:center;gap:8px;margin-top:8px}
.code-actions .btn svg{width:11px;height:11px}
.pairing-status{font-size:10px;margin-top:4px;min-height:16px;color:var(--vscode-descriptionForeground,#50506e);text-align:center}
.pairing-status.success{color:#2ecc71}
.pairing-status.error{color:#f74d4d}
.pairing-status.waiting{color:var(--vscode-textLink-foreground,#8888a8)}
.qr-visual-wrap{display:inline-block;background:var(--vscode-sideBar-background,#07070c);border-radius:6px;border:1px solid var(--vscode-panel-border,#1e1e2e);padding:4px}
.qr-side .hint{font-size:10px;color:var(--vscode-descriptionForeground,#50506e);line-height:1.4}
.qr-side .hint strong{color:var(--vscode-editor-foreground)}
.qr-bottom{display:flex;align-items:center}
.qr-status{font-size:10px;color:var(--vscode-descriptionForeground,#50506e);min-height:16px}
.qr-status.success{color:#2ecc71}

/* paired-compact: shown when device is already paired */
.paired-compact{padding:2px 0}
.paired-row{display:flex;align-items:center;gap:10px}
.paired-icon{
  width:24px;height:24px;border-radius:50%;
  display:flex;align-items:center;justify-content:center;
  background:rgba(46,204,113,.12);color:#2ecc71;flex-shrink:0;
}
.paired-text{flex:1;min-width:0}
.paired-title{font-size:12px;font-weight:500;color:var(--vscode-editor-foreground)}
.paired-sub{font-size:10px;color:var(--vscode-descriptionForeground,#50506e);margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* platform toggle — three icons */
.platform-toggle{display:flex;gap:4px;margin-bottom:8px}
.plat-opt{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;padding:8px 4px;border-radius:6px;border:1px solid var(--vscode-panel-border,#1e1e2e);cursor:pointer;font-size:9px;font-weight:500;color:var(--vscode-descriptionForeground,#50506e);transition:all .2s;user-select:none}
.plat-opt:hover{border-color:var(--vscode-descriptionForeground,#50506e);color:var(--vscode-editor-foreground)}
.plat-opt.active{border-color:var(--vscode-textLink-foreground,#00ffe0);color:var(--vscode-textLink-foreground,#00ffe0);background:rgba(0,255,224,.06)}
.plat-opt.disabled{opacity:.4;pointer-events:none}
.plat-opt svg{width:14px;height:14px}
.plat-badge{font-size:7px;padding:1px 4px;border-radius:99px;background:rgba(255,255,255,.06);color:var(--vscode-descriptionForeground,#50506e);white-space:nowrap}
.tg-guide{margin-top:8px;text-align:left;font-size:10px;color:var(--vscode-descriptionForeground,#50506e);line-height:1.6}
.tg-key-info{margin-top:4px;border-top:1px solid var(--vscode-widget-border,#333);padding-top:6px}
.key-text{font-family:monospace;font-size:11px;word-break:break-all;background:var(--vscode-editor-background,#1a1a2e);padding:6px 8px;border-radius:4px;margin:4px 0;color:var(--vscode-editor-foreground,#ccc)}
.guide-step strong{color:var(--vscode-editor-foreground)}

/* ═══════════════════════════════════════════════
   AGENT TABS
   ═══════════════════════════════════════════════ */
.agent-tabs{
  display:flex;gap:4px;margin-bottom:6px;
  padding-bottom:6px;border-bottom:1px solid var(--vscode-panel-border,#1e1e2e);
  overflow-x:auto;
}
.agent-tabs::-webkit-scrollbar{height:2px}
.agent-tabs::-webkit-scrollbar-thumb{background:var(--vscode-panel-border,#1e1e2e);border-radius:2px}
.agent-tab{
  padding:3px 10px;border-radius:99px;
  font-size:10px;font-weight:500;
  background:var(--vscode-button-secondaryBackground,#181824);
  color:var(--vscode-descriptionForeground,#50506e);
  cursor:pointer;white-space:nowrap;
  border:1px solid transparent;
  transition:all .2s;user-select:none;
}
.agent-tab:hover{color:var(--vscode-editor-foreground);border-color:var(--vscode-panel-border,#1e1e2e)}
.agent-tab.active{
  background:rgba(0,255,224,.08);color:var(--vscode-textLink-foreground,#00ffe0);
  border-color:rgba(0,255,224,.15);
}

/* ═══════════════════════════════════════════════
   PRIVACY PANEL
   ═══════════════════════════════════════════════ */
.privacy-summary{padding:0}
.privacy-row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px;align-items:center}
.privacy-pill{font-size:10px;background:var(--vscode-panel-border,#1e1e2e);color:var(--vscode-descriptionForeground,#7878a0);border-radius:4px;padding:2px 6px;white-space:nowrap}
.privacy-pill-clickable{cursor:pointer;transition:opacity .15s;user-select:none}
.privacy-pill-clickable:hover{opacity:.8}
.privacy-pill-clickable:active{opacity:.6}
.privacy-pill-warn{color:#f59e0b;border:1px solid #f59e0b33}
.privacy-pill-block{color:#f74d4d;border:1px solid #f74d4d33}
.privacy-findings{font-size:10px;color:var(--vscode-descriptionForeground,#7878a0)}
.privacy-entries{display:flex;flex-direction:column;gap:4px;margin-top:4px;max-height:180px;overflow-y:auto}
.privacy-entry{background:var(--vscode-panel-border,#1e1e2e);border-radius:6px;padding:5px 7px}
.privacy-entry-hdr{display:flex;align-items:center;gap:6px;font-size:10px}
.privacy-tag{font-size:9px;padding:1px 4px;border-radius:3px;font-weight:600;text-transform:uppercase}
.privacy-tag.forwarded{background:#86efac22;color:#86efac}
.privacy-tag.blocked{background:#f74d4d22;color:#f74d4d}
.privacy-tag.sanitized{background:#f59e0b22;color:#f59e0b}
.privacy-tag.redacted_path{background:#f59e0b22;color:#f59e0b}
.privacy-source{color:var(--vscode-descriptionForeground,#7878a0)}
.privacy-len{margin-left:auto;color:var(--vscode-descriptionForeground,#50506e)}
.privacy-preview{font-size:10px;color:var(--vscode-descriptionForeground,#7878a0);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace}

/* ═══════════════════════════════════════════════
   HISTORY SHARE
   ═══════════════════════════════════════════════ */
.hp-row{
  display:flex;align-items:center;justify-content:space-between;
  padding:5px 0;gap:8px;
  border-bottom:1px solid rgba(255,255,255,.03);
}
.hp-row:last-child{border-bottom:none;padding-bottom:0}
.hp-row:first-child{padding-top:0}
.hp-label{font-size:11px;color:var(--vscode-editor-foreground,#e8e8f0);flex-shrink:0;white-space:nowrap}
.hp-controls{display:flex;align-items:center;gap:4px;flex-shrink:0}
.hp-select{
  background:var(--vscode-dropdown-background,#1a1a2e);
  color:var(--vscode-dropdown-foreground,#e8e8f0);
  border:1px solid var(--vscode-dropdown-border,#333);
  border-radius:4px;padding:2px 4px;
  font-size:10px;font-family:var(--vscode-font-family,system-ui);
  cursor:pointer;outline:none;min-width:88px;
}
.hp-select:focus{border-color:var(--vscode-focusBorder,#5c9cf5)}
/* ═══════════════════════════════════════════════
   ANIMATIONS
   ═══════════════════════════════════════════════ */
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.card{animation:fadeIn .4s cubic-bezier(.4,0,.2,1) both}
.card:nth-child(2){animation-delay:.05s}
.card:nth-child(3){animation-delay:.1s}
.card:nth-child(4){animation-delay:.15s}
.card:nth-child(5){animation-delay:.2s}
.card:nth-child(6){animation-delay:.25s}
.card:nth-child(7){animation-delay:.3s}
`;
