import type { SessionResponse, EventResponse } from '../api/client.js';
import type { AgentDef } from '../agents/registry.js';
import type { BridgeState } from '../services/bridge-status.js';

export interface PendingApprovalItem {
  id: string;
  command: string;
  agent: string;
  risk: string;
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
}

// ── Helpers ──────────────────────────────────────────────

function h(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
        ${a.status === 'available' ? `<div class="button-row">
          <button class="btn btn-primary" data-action="start-agent" data-agent="${h(a.id)}">Launch</button>
          <button class="btn" data-action="set-default" data-agent="${h(a.id)}">Default</button>
        </div>` : ''}
      </div>`;
    }).join('')}
  </div>`;
}

function renderApprovals(state: SidebarState): string {
  if (state.pendingApprovals.length === 0) return '';
  return `<div class="section">
    <div class="section-title"><span>PENDING</span>${tag(String(state.pendingApprovals.length), 'red')}</div>
    ${state.pendingApprovals.map(a => {
      const rCls = a.risk === 'high' || a.risk === 'critical' ? 'red' : 'orange';
      return `<div class="item danger">
        <div class="cmd">${h(a.command)}</div>
        <div class="row"><span class="muted">${h(a.agent)}</span>${tag(a.risk, rCls)}</div>
      </div>`;
    }).join('')}
  </div>`;
}

function renderSessions(state: SidebarState): string {
  if (state.sessions.length === 0) return '';
  const sid = (id: string) => id.length > 12 ? id.slice(0, 8) + '...' + id.slice(-3) : id;
  return `<div class="section">
    <div class="section-title"><span>SESSIONS</span>${tag(String(state.sessions.length), '')}</div>
    ${state.sessions.map(s => {
      const evts = state.events[s.id] ?? [];
      const pending = evts.filter(e => e.pending).length;
      const sTag = pending > 0 ? tag('pending', 'orange') : tag('idle', '');
      return `<div class="item">
        <div class="row"><span>${h(s.agent_type)}</span>${sTag}</div>
        <div class="muted">${sid(s.id)}</div>
      </div>`;
    }).join('')}
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
${renderApprovals(state)}
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
    if (action === 'start-agent' || action === 'set-default') {
      api.postMessage({ action, agent: target.dataset.agent });
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
`;
