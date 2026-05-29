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

function renderDevice(state: SidebarState): string {
  const { deviceStatus, bridge, phoneName } = state;
  const statusTag = deviceStatus === 'paired' ? tag('Paired', 'green')
    : deviceStatus === 'offline' ? tag('Offline', 'red')
    : tag('Unpaired', 'orange');

  const bridgeTag = bridge.bridge === 'running' ? tag('Running', 'green')
    : bridge.bridge === 'connecting' ? tag('Connecting...', 'yellow')
    : bridge.bridge === 'error' ? tag('Error', 'red')
    : tag('Stopped', 'orange');

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
    <div class="row"><span class="muted">Bridge</span>${bridgeTag}</div>
    <div class="row"><span class="muted">Hook</span>${hookTag}</div>
    <div class="button-row">
      <button class="btn" data-action="pair">${deviceStatus === 'paired' ? 'Re-Pair' : 'Pair Device'}</button>
      <button class="btn" data-action="hook-settings">Hook</button>
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
    ${items.map(s => `
      <div class="item" style="padding:6px 0">
        <div style="font-weight:500;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${h(s.title || s.sessionId.slice(0, 8))}">${h(truncate(s.title || s.sessionId.slice(0, 8), 60))}</div>
        <div class="row" style="margin:2px 0">
          <span class="muted" style="font-size:10px">${h(truncate(s.cwd || '', 50))}</span>
          <span class="muted" style="font-size:10px">${h(formatTime(s.updatedAt))}</span>
        </div>
        <div class="row" style="margin:2px 0">
          <span class="muted" style="font-size:10px;font-family:monospace">${h(s.sessionId.slice(0, 8))}</span>
          ${s.canDetach
            ? `<button class="${s.attached ? 'btn btn-attached' : 'btn'}"
                 data-action="toggleAttachClaudeSession"
                 data-session-id="${h(s.sessionId)}"
                 data-attached="${s.attached ? 'true' : 'false'}"
                 style="font-size:10px">${s.attached ? 'Attached' : 'Attach'}</button>`
            : `<button class="btn" data-action="attachClaudeSession"
                 data-session-id="${h(s.sessionId)}"
                 style="font-size:10px">Attach</button>`}
        </div>
      </div>
    `).join('')}
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
${renderDevice(state)}
${renderAgents(state)}
${renderClaudeSessions(state)}
${renderSessions(state)}
${renderSubscribe()}
<script nonce="${NONCE}">
(function() {
  const api = acquireVsCodeApi();
  document.addEventListener('click', function(e) {
    const target = e.target instanceof HTMLElement
      ? e.target.closest('button[data-action]')
      : null;
    if (!target) return;
    const action = target.dataset.action;
    if (action === 'attachClaudeSession') {
      api.postMessage({ action, sessionId: target.dataset.sessionId });
    } else if (action === 'toggleAttachClaudeSession') {
      api.postMessage({
        action,
        sessionId: target.dataset.sessionId,
        attached: target.dataset.attached === 'true',
      });
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
`;
