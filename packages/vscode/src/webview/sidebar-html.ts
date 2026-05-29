import type { SessionResponse, EventResponse } from '../api/client.js';
import type { AgentDef } from '../agents/registry.js';
import type { BridgeState } from '../services/bridge-status.js';

export interface PendingApprovalItem {
  id: string;
  command: string;
  agent: string;
  risk: string;
  serverSessionId: string;
}

export interface SidebarState {
  deviceStatus: 'unpaired' | 'paired' | 'offline';
  phoneName: string;
  bridge: BridgeState;
  agents: (AgentDef & {
    runtimeStatus: 'active' | 'idle' | 'unavailable';
    statusLine?: string;
    lastMessage?: string;
  })[];
  pendingApprovals: PendingApprovalItem[];
  sessions: SessionResponse[];
  events: Record<string, EventResponse[]>;
  claudeSessions: ClaudeSessionItem[];
}

export interface ClaudeSessionItem {
  sessionId: string;
  title: string;
  cwd: string;
  updatedAt: string;
  attached?: boolean;
  canDetach?: boolean;
}

// ── Helpers ──────────────────────────────────────────────

function h(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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

function tag(text: string, cls: string): string {
  return `<span class="tag ${cls}">${h(text)}</span>`;
}

// ── Section renderers ────────────────────────────────────

function renderBrandHeader(): string {
  return `<div class="brand-header">
    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="display:block;margin:0 auto 6px">
      <rect x="6" y="2" width="12" height="20" rx="2.5" stroke="var(--vscode-editor-foreground)" stroke-width="1.5" opacity="0.8"/>
      <path d="M9.5 9.5L7.5 12L9.5 14.5" stroke="var(--vscode-editor-foreground)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
      <path d="M14.5 9.5L16.5 12L14.5 14.5" stroke="var(--vscode-editor-foreground)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity="0.8"/>
      <path d="M17 4.5L17.35 5.65L18.5 6L17.35 6.35L17 7.5L16.65 6.35L15.5 6L16.65 5.65Z" fill="var(--vscode-editor-foreground)" opacity="0.8"/>
    </svg>
    <div class="brand-title">CodeKey</div>
    <div class="brand-subtitle">AI Coding Remote</div>
  </div>`;
}

function renderDevice(state: SidebarState): string {
  const { deviceStatus, bridge, phoneName } = state;
  const statusTag = deviceStatus === 'paired' ? tag('Paired', 'green')
    : deviceStatus === 'offline' ? tag('Offline', 'red')
    : tag('Unpaired', 'orange');

  const serverLabel = bridge.bridge === 'running' && bridge.relay === 'connected' ? 'Connected'
    : bridge.bridge === 'connecting' || bridge.relay === 'connecting' ? 'Connecting...'
    : bridge.relay === 'disconnected' && bridge.bridge === 'running' ? 'Disconnected'
    : 'Offline';
  const serverCls = serverLabel === 'Connected' ? 'green'
    : serverLabel === 'Connecting...' ? 'yellow'
    : 'red';
  const serverTag = tag(serverLabel, serverCls);

  const hookLabel = bridge.hookConfig === 'enabled' ? 'Enabled'
    : bridge.hookInstalled ? 'Installed'
    : 'Not Found';
  const hookCls = bridge.hookConfig === 'enabled' ? 'green'
    : bridge.hookInstalled ? 'orange'
    : 'orange';
  const hookTag = tag(hookLabel, hookCls);

  return `<div class="section">
    <div class="section-title"><span>DEVICE</span>${statusTag}</div>
    <div class="row"><span class="muted">Phone</span><span>${h(phoneName)}</span></div>
    <div class="row"><span class="muted">Server</span>${serverTag}</div>
    <div class="row"><span class="muted">Hook</span>${hookTag}</div>
    <div class="button-row">
      <button class="btn" data-action="pair">${deviceStatus === 'paired' ? 'Re-Pair' : 'Pair Device'}</button>
      <button class="btn" data-action="hook-settings">Hook</button>
      <button class="btn" data-action="relayReconnect" style="font-size:10px">Reconnect</button>
    </div>
  </div>`;
}

function renderAgents(state: SidebarState): string {
  const active = state.agents.filter(a => a.runtimeStatus === 'active').length;
  return `<div class="section">
    <div class="section-title"><span>AGENTS</span>${tag(active + ' active', '')}</div>
    ${state.agents.map(a => {
      const statusTag = a.status === 'coming_soon' ? tag('Coming soon', '')
        : a.runtimeStatus === 'active' ? tag('Active', 'green')
        : tag('Idle', '');
      const isActive = a.runtimeStatus === 'active';
      return `<div class="agent${isActive ? ' active' : ''}">
        <div class="row"><span class="agent-name">${h(a.name)}</span>${statusTag}</div>
        <div class="muted">${h(a.description)}</div>
        ${a.statusLine ? `<div class="status-line">${h(a.statusLine)}</div>` : ''}
        ${a.lastMessage ? `<div class="last-msg muted">${h(a.lastMessage)}</div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderPendingList(pending: PendingApprovalItem[]): string {
  if (pending.length === 0) return '';
  return pending.map(a => {
    const rCls = a.risk === 'high' || a.risk === 'critical' ? 'red' : 'orange';
    const cmd = a.command.length > 55 ? a.command.slice(0, 52) + '…' : a.command;
    return `<div class="item danger" style="margin-left:12px;padding:4px 0;display:flex;align-items:center;gap:4px;font-size:11px;overflow:hidden">
      <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace">${h(cmd)}</span>
      <span class="muted" style="flex-shrink:0">${h(a.agent)}</span>
      ${tag(a.risk, rCls)}
    </div>`;
  }).join('');
}

function renderSessions(state: SidebarState): string {
  // Build per-session pending lookup
  const pendingBySession: Record<string, PendingApprovalItem[]> = {};
  for (const a of state.pendingApprovals) {
    if (!pendingBySession[a.serverSessionId]) pendingBySession[a.serverSessionId] = [];
    pendingBySession[a.serverSessionId]!.push(a);
  }

  // Only show sessions that have pending approvals
  const active = Object.entries(pendingBySession);
  if (active.length === 0) return '';

  return `<div class="section">
    <div class="section-title"><span>APPROVALS</span>${tag(String(active.length), 'orange')}</div>
    ${active.map(([sessionId, pending]) => {
      const s = state.sessions.find(s => s.id === sessionId);
      const sid = s?.id ? (s.id.length > 12 ? s.id.slice(0, 8) + '…' + s.id.slice(-3) : s.id) : sessionId.slice(0, 8);
      const label = s?.metadata?.claudeSessionId?.slice(0, 8) || sid;
      const ts = s?.last_active_at || s?.created_at || '';
      return `<div class="session-group">
        <div class="item" style="padding:4px 0">
          <div class="row" style="margin:0">
            <span style="font-size:11px"><b>${h(s?.agent_type || '?')}</b> ${h(label)}</span>
            <span style="display:flex;align-items:center;gap:4px">
              <span class="muted" style="font-size:10px">${h(formatTime(ts))}</span>
              ${tag(`${pending.length} pending`, 'orange')}
            </span>
          </div>
        </div>
        ${renderPendingList(pending)}
      </div>`;
    }).join('')}
  </div>`;
}

function renderClaudeSessions(state: SidebarState): string {
  const items = state.claudeSessions.slice().sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });
  return `<div class="section">
    <div class="section-header" style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
      <span class="section-title" style="font-weight:600;font-size:11px;text-transform:uppercase;letter-spacing:0.04em">Local Sessions</span>
      <span style="display:flex;gap:4px">
        <button class="ico-btn" data-action="refreshClaudeSessions" title="Refresh">↻</button>
      </span>
    </div>
    ${items.length === 0 ? '<div class="muted" style="font-size:11px">No local Claude sessions found</div>' : ''}
    <div class="session-scroll">
    ${items.map(s => `
      <div class="item session-item" style="padding:6px 0">
        <div class="session-title-row" data-action="togglePreview" data-session-id="${h(s.sessionId)}" style="cursor:pointer">
          <span class="chevron">▶</span>
          <span class="session-title" title="${h(s.title || s.sessionId.slice(0, 8))}">${h(truncate(s.title || s.sessionId.slice(0, 8), 60))}</span>
        </div>
        <div class="row" style="margin:2px 0">
          <span class="muted" style="font-size:10px">${h(truncate(s.cwd || '', 50))}</span>
          <span class="muted" style="font-size:10px">${h(formatTime(s.updatedAt))}</span>
        </div>
        <div class="row" style="margin:2px 0">
          <span class="muted" style="font-size:10px;font-family:monospace">${h(s.sessionId.slice(0, 8))}</span>
          <span style="display:flex;gap:4px">
            <button class="${s.attached ? 'btn btn-attached' : 'btn'}"
                data-action="toggleAttachClaudeSession"
                data-session-id="${h(s.sessionId)}"
                data-attached="${s.attached ? 'true' : 'false'}"
                style="font-size:10px;width:60px">${s.attached ? '已推送' : '推送远程'}</button>
            <button class="btn"
                data-action="openSession"
                data-session-id="${h(s.sessionId)}"
                style="font-size:10px;width:60px">打开会话</button>
          </span>
        </div>
        <div class="preview" id="preview-${h(s.sessionId)}" style="display:none"></div>
      </div>
    `).join('')}
    </div>
  </div>`;
}

function renderSubscribe(): string {
  return `<div class="section">
    <div class="subscription">Free plan</div>
  </div>`;
}

// ── Main render ──────────────────────────────────────────

const NONCE = 'ck2026sid';

export function renderSidebar(state: SidebarState): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; script-src 'nonce-${NONCE}';">
<style>${STYLES}</style>
</head>
<body>
${renderBrandHeader()}
${renderDevice(state)}
${renderAgents(state)}
${renderClaudeSessions(state)}
${renderSessions(state)}
${renderSubscribe()}
<script nonce="${NONCE}">
(function() {
  const api = acquireVsCodeApi();

  // Listen for session preview data from extension host
  window.addEventListener('message', function(e) {
    if (e.data && e.data.type === 'sessionPreview') {
      var sid = e.data.sessionId;
      var container = document.getElementById('preview-' + sid);
      if (!container) return;
      if (e.data.count === 0) {
        container.innerHTML = '<div class="preview-empty">No conversation found</div>';
      } else {
        var html = '';
        for (var i = 0; i < e.data.entries.length; i++) {
          var entry = e.data.entries[i];
          var side = entry.role === 'user' ? 'right' : 'left';
          var label = entry.role === 'user' ? 'You' : 'Claude';
          var ts = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString() : '';
          html += '<div class="pv-msg pv-msg-' + side + '">'
            + '<div class="pv-label">' + label + ' <span class="pv-time">' + ts + '</span></div>'
            + '<div class="pv-bubble pv-bubble-' + side + '">' + entry.text + '</div>'
            + '</div>';
        }
        container.innerHTML = html;
      }
      container.style.display = 'block';
    }
  });

  document.addEventListener('click', function(e) {
    var target = e.target instanceof HTMLElement
      ? e.target.closest('[data-action]')
      : null;
    if (!target) return;
    var action = target.dataset.action;

    if (action === 'togglePreview') {
      var sid = target.dataset.sessionId;
      var container = document.getElementById('preview-' + sid);
      if (!container) return;
      var item = target.closest('.session-item');
      var chevron = target.querySelector('.chevron');
      if (!chevron) chevron = item?.querySelector('.chevron');
      if (container.style.display === 'block') {
        // Collapse
        container.style.display = 'none';
        if (chevron) chevron.textContent = '▶';
      } else {
        // Expand: show loading, request data
        container.innerHTML = '<div class="preview-empty">Loading...</div>';
        container.style.display = 'block';
        if (chevron) chevron.textContent = '▼';
        api.postMessage({ action: 'getSessionPreview', sessionId: sid });
      }
      return;
    }

    if (action === 'openSession') {
      api.postMessage({ action: 'openSession', sessionId: target.dataset.sessionId });
    } else if (action === 'toggleAttachClaudeSession') {
      api.postMessage({
        action,
        sessionId: target.dataset.sessionId,
        attached: target.dataset.attached === 'true',
      });
    } else if (action === 'attachClaudeSession' || action === 'detachSession') {
      api.postMessage({ action, sessionId: target.dataset.sessionId });
    } else {
      api.postMessage({ action });
    }
  });
})();
</script>
</body>
</html>`;
}

const STYLES = `
body {
  margin: 0; padding: 0;
  font-family: var(--vscode-font-family);
  font-size: var(--vscode-font-size);
  color: var(--vscode-editor-foreground);
  background: var(--vscode-sideBar-background);
}
.section {
  padding: 10px 12px;
  border-bottom: 1px solid var(--vscode-panel-border);
}
.section-title {
  display: flex; align-items: center; justify-content: space-between;
  font-weight: 600; font-size: 11px; text-transform: uppercase;
  letter-spacing: 0.04em; margin-bottom: 8px;
}
.row {
  display: flex; align-items: center; justify-content: space-between;
  gap: 8px; margin: 4px 0;
}
.muted { color: var(--vscode-descriptionForeground); }
.tag {
  padding: 1px 8px; border-radius: 999px;
  background: var(--vscode-badge-background);
  color: var(--vscode-badge-foreground);
  font-size: 10px; font-weight: 500; white-space: nowrap;
}
.tag.green { background: #173b27; color: #8fe0a5; }
.tag.yellow { background: #4b4a1b; color: #ffea8a; }
.tag.orange { background: #4b341b; color: #ffd18a; }
.tag.red { background: #552424; color: #ffaaa8; }
.btn {
  border: 1px solid var(--vscode-button-secondaryBorder, #444);
  background: var(--vscode-button-secondaryBackground, #333);
  color: var(--vscode-button-secondaryForeground, #ddd);
  padding: 4px 8px; border-radius: 4px;
  text-align: center; font-size: 11px; cursor: pointer;
}
.btn:hover { background: var(--vscode-button-secondaryHoverBackground, #444); }
.btn-primary {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}
.button-row { display: flex; gap: 6px; margin-top: 8px; }
.agent { padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.agent:last-child { border-bottom: none; }
.agent-name { font-weight: 500; }
.status-line { font-size: 11px; color: var(--vscode-textLink-foreground); margin-top: 2px; }
.last-msg { font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.item { padding: 6px 0; border-bottom: 1px solid var(--vscode-panel-border); }
.item:last-child { border-bottom: none; }
.item.danger { border-left: 3px solid #e5534b; padding-left: 8px; }
.cmd { font-family: monospace; font-size: 11px; word-break: break-all; margin-bottom: 4px; }
.subscription { font-size: 11px; color: var(--vscode-descriptionForeground); text-align: center; padding: 4px 0; }
.ico-btn { background:none; border:none; color:var(--vscode-textLink-foreground); cursor:pointer; font-size:14px; padding:2px 4px; line-height:1; }
.ico-btn:hover { opacity:0.8; }
.session-group { margin-bottom:4px; }
.btn-attached {
  background: var(--vscode-button-background);
  color: var(--vscode-button-foreground);
  border-color: var(--vscode-button-background);
}
.brand-header { padding: 16px 12px 8px; text-align: center; border-bottom: 1px solid var(--vscode-panel-border); }
.brand-title { font-size: 18px; font-weight: 700; letter-spacing: 0.02em; }
.brand-subtitle { font-size: 11px; color: var(--vscode-descriptionForeground); margin-top: 2px; }
.session-title-row { display: flex; align-items: center; gap: 4px; }
.session-title { font-weight:500; font-size:12px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; }
.session-title-row:hover .session-title { color: var(--vscode-textLink-foreground); }
.chevron { font-size: 9px; color: var(--vscode-descriptionForeground); flex-shrink:0; width: 12px; text-align: center; }
.session-title-row:hover .chevron { color: var(--vscode-textLink-foreground); }
.session-scroll { max-height: 380px; overflow-y: auto; overflow-x: hidden; }
.session-scroll::-webkit-scrollbar { width: 5px; }
.session-scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); border-radius: 3px; }
.session-scroll::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
.preview { padding: 6px 0 2px 16px; border-top: none; }
.preview-empty { font-size: 11px; color: var(--vscode-descriptionForeground); padding: 8px 0; text-align: center; }
.pv-msg { margin-bottom: 8px; }
.pv-label { font-size: 10px; font-weight: 600; margin-bottom: 2px; color: var(--vscode-descriptionForeground); }
.pv-time { font-size: 9px; font-weight: 400; color: var(--vscode-descriptionForeground); }
.pv-bubble { padding: 6px 10px; border-radius: 6px; font-size: 11px; line-height: 1.4; white-space: pre-wrap; word-wrap: break-word; }
.pv-bubble-left { background: var(--vscode-textCodeBlock-background); }
.pv-bubble-right { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
`;
