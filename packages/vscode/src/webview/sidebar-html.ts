import type { SessionResponse, EventResponse } from '../api/client.js';
import type { AgentDef } from '../agents/registry.js';
import type { BridgeState } from '../services/bridge-status.js';

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
  platform: 'wechat' | 'feishu';
  status: 'idle' | 'waiting' | 'paired' | 'error';
  statusText: string;
  expiresAt: number;
  pairUrl?: string;
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
  /** True when this Codex session has been resumed */
  resumed?: boolean;
}

// ── Helpers ──────────────────────────────────────────────

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
    <div class="brand-icon">
      <div class="brand-glow"></div>
      <svg viewBox="0 0 24 24" fill="none">
        <rect x="6" y="2" width="12" height="20" rx="2.5" stroke="currentColor" stroke-width="1.5" opacity=".6"/>
        <path d="M9.5 9.5L7.5 12l2 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>
        <path d="M14.5 9.5l2 2.5-2 2.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" opacity=".8"/>
        <path d="M17 4.5l.35 1.15L18.5 6l-1.15.35L17 7.5l-.35-1.15L15.5 6l1.15-.35z" fill="currentColor" opacity=".8"/>
      </svg>
    </div>
    <div class="brand-name">Code<span class="brand-em">Key</span></div>
    <div class="brand-sub">A I &nbsp;C o d i n g &nbsp;R e m o t e</div>
  </div>`;
}

export function renderDeviceContent(state: SidebarState): string {
  const serverConnected = state.bridge.relay === 'connected';
  const serverDot = dot(serverConnected ? 'green' : 'red');
  const serverLabel = serverConnected ? 'Connected' : 'Disconnected';
  const hasPhone = state.deviceStatus !== 'unpaired';
  const mpOnline = state.deviceStatus === 'paired' && state.bridge.mpOnline;
  const mpDot = dot(mpOnline ? 'green' : 'gray');
  const mpLabel = mpOnline ? 'Phone Online' : hasPhone ? 'Phone Offline' : '';
  return `<div class="row" style="cursor:pointer" data-action="relayReconnect" title="Click to reconnect"><span class="row-label">Server</span><span class="row-val">${serverDot}${serverLabel}</span></div>
    ${mpLabel ? `<div class="row"><span class="row-label">Phone</span><span class="row-val">${mpDot}${mpLabel}</span></div>` : ''}`;
}

function renderDevice(state: SidebarState): string {
  const { deviceStatus } = state;
  const paired = deviceStatus === 'paired';
  const offline = deviceStatus === 'offline';
  const statusDot = paired ? dot('green') : offline ? dot('red pulse') : dot('orange pulse');
  const statusLabel = paired ? 'Online' : offline ? 'Offline' : 'Not paired';
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="2" width="16" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
        Device
      </span>
      <span class="tag ${paired ? 'green' : offline ? 'red' : 'orange'}" id="deviceStatusTag">${statusDot}${statusLabel}</span>
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
  if (state.agents.length === 0) return '<div class="empty-state">No agents configured</div>';
  return state.agents.map(a => {
    const isActive = a.runtimeStatus === 'active';
    const activeColor = AGENT_DOT_CLASS[a.id] || 'green';
    const dotClass = isActive ? `${activeColor} pulse` : 'gray';
    const integOk = a.integrationStatus === 'enabled';
    let modeHtml = '';
    if (a.canInstall) {
      modeHtml = `<a class="agent-install" data-action="install-opencode">Install</a>`;
    } else if (!integOk) {
      modeHtml = 'Reinstall CodeKey';
    } else {
      const modeMap: Record<string, string> = { 'claude-code': 'Hook', 'codex': 'Hook', 'opencode': 'Plugin + SDK' };
      modeHtml = modeMap[a.id] || 'Ready';
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
        Agents
      </span>
      <span class="badge${active > 0 ? ' green' : ''}" id="agentsBadge">${active} active</span>
    </div>
    <div id="agentsContent">${renderAgentsContent(state)}</div>
  </div>`;
}

export function renderApprovalsContent(state: SidebarState): string {
  const pending = state.pendingApprovals;
  if (pending.length === 0) return '<div class="empty-state">No pending approvals</div>';

  const groups: Record<string, { agent: string; items: typeof pending; ts: string }> = {};
  for (const a of pending) {
    if (!groups[a.serverSessionId]) {
      const s = state.sessions.find(s => s.id === a.serverSessionId);
      groups[a.serverSessionId] = { agent: a.agent, items: [], ts: s?.last_active_at || s?.created_at || '' };
    }
    groups[a.serverSessionId].items.push(a);
  }

  return Object.entries(groups).map(([sid, g]) => `
    <div class="approval-session">
      <div class="approval-header">
        <span class="approval-agent">${h(g.agent)}</span>
        <span class="tag orange">${g.items.length} pending</span>
      </div>
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
  `).join('');
}

function renderApprovals(state: SidebarState): string {
  const pending = state.pendingApprovals;
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Approvals
      </span>
      <span class="badge${pending.length > 0 ? ' orange' : ''}" id="approvalsBadge">${pending.length} pending</span>
    </div>
    <div id="approvalsContent">${renderApprovalsContent(state)}</div>
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
  if (items.length === 0) return tabsHtml + '<div class="empty-state">No local sessions</div>';
  const maxVisible = 5;
  const itemsHtml = items.map((s, i) => {
    const hidden = i >= maxVisible;
    const extraCls = hidden ? ' session-hidden' : '';
    return _sessionItemHtml(s, extraCls);
  }).join('');
  return tabsHtml
    + '<div class="session-scroll">'
    + itemsHtml
    + '<div class="session-show-more" id="sessionShowMore"><button class="btn-ghost btn-sm" data-action="toggleShowMoreSessions">+ ' + Math.max(0, items.length - maxVisible) + ' more</button></div>'
    + '</div>';
}

function _sessionItemHtml(s: any, extraCls: string): string {
      const isAttached = s.attached;
      const sid = s.sessionId;
      const btnCls = isAttached ? 'btn-attached' : '';
      const btnText = isAttached ? 'Detach' : 'Attach';
      const agent = s.isOpenCodeSession ? 'opencode' : s.isCodexSession ? 'codex' : 'claude-code';
      const isCodex = s.isCodexSession ? 'true' : 'false';
      const isOpenCode = s.isOpenCodeSession ? 'true' : '';
      return `<div class="session-item${extraCls}" data-sid="${h(sid)}" data-agent="${agent}">
        <div class="session-title-row">
          <span class="session-title-click" data-action="togglePreview" data-session-id="${h(sid)}" data-iscodex="${isCodex}" data-isopencode="${isOpenCode}">
            <span class="chevron">&#9654;</span>
            <span class="session-title" title="${h(_displayTitle(s))}">${h(truncate(_displayTitle(s), 60))}</span>
          </span>
          <button class="btn btn-sm ${btnCls}" data-action="toggleAttachClaudeSession" data-session-id="${h(sid)}" data-attached="${isAttached ? 'true' : 'false'}"${s.isCodexSession ? ' data-iscodex="true"' : ''}${s.isOpenCodeSession ? ' data-isopencode="true"' : ''}>${btnText}</button>
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
  if (s.isOpenCodeSession && !s.title) return 'OpenCode session';
  if (/^[0-9a-f]{8}/.test(t) && t.length >= 8) return 'Codex session';
  return t;
}

function renderClaudeSessions(state: SidebarState): string {
  return `<div class="card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Local Sessions
      </span>
      <button class="btn-ghost btn-sm" data-action="refreshClaudeSessions" title="Refresh" style="font-size:11px;padding:2px 6px">↻</button>
    </div>
    <div id="sessionsContent">${renderSessionsContent(state)}</div>
  </div>`;
}

function renderSubscribe(): string {
  return `<div class="footer">CodeKey &middot; AI Coding Remote</div>`;
}

// ── Pairing card ─────────────────────────────────────────

/**
 * Minimal QR code generator → SVG.  Generates a real, scannable QR code
 * for the pairing code so the WeChat mini program can read it via wx.scanCode.
 * Supports alphanumeric mode, version 2 (25×25), ECC level M.
 */
function generateQrSvg(text: string, size: number = 200): string {
  if (!text) return '';

  // ── QR code constants (Version 2, ECC M, Alphanumeric) ──
  const N = 25;          // module count for version 2
  const EC_CODEWORDS = 10;
  const EC_BLOCKS = 1;
  const DATA_CODEWORDS = 44;
  const TOTAL_BITS = DATA_CODEWORDS * 8;

  // Alphanumeric character set
  const ALPHANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
  const charVal = (c: string): number => {
    const idx = ALPHANUM.indexOf(c);
    return idx >= 0 ? idx : 0;
  };

  // ── Encode data ──
  const bits: number[] = [];
  // Mode indicator: 0010 (alphanumeric)
  bits.push(0, 0, 1, 0);
  // Character count (9 bits for v2 alphanumeric)
  for (let i = 8; i >= 0; i--) bits.push((text.length >> i) & 1);
  // Data
  for (let i = 0; i < text.length - 1; i += 2) {
    const val = charVal(text[i]) * 45 + charVal(text[i + 1]);
    for (let b = 10; b >= 0; b--) bits.push((val >> b) & 1);
  }
  if (text.length % 2 === 1) {
    const val = charVal(text[text.length - 1]);
    for (let b = 5; b >= 0; b--) bits.push((val >> b) & 1);
  }
  // Terminator
  for (let i = 0; i < 4 && bits.length < TOTAL_BITS; i++) bits.push(0);
  // Pad to byte boundary
  while (bits.length % 8 !== 0) bits.push(0);
  // Pad bytes
  const padBytes = [0xEC, 0x11];
  let pi = 0;
  while (bits.length < TOTAL_BITS) {
    for (let b = 7; b >= 0; b--) bits.push((padBytes[pi % 2] >> b) & 1);
    pi++;
  }

  // ── Convert to codewords ──
  const dataWords: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let b = 0; b < 8; b++) byte = (byte << 1) | (bits[i + b] || 0);
    dataWords.push(byte);
  }

  // ── Reed-Solomon (GF(2^8) with polynomial 0x11D) ──
  const gfExp: number[] = new Array(512);
  const gfLog: number[] = new Array(256);
  let x = 1;
  for (let i = 0; i < 255; i++) {
    gfExp[i] = x;
    gfLog[x] = i;
    x = (x << 1) ^ (x >= 128 ? 0x11D : 0);
  }
  for (let i = 255; i < 512; i++) gfExp[i] = gfExp[i - 255];

  const gfMul = (a: number, b: number): number =>
    a === 0 || b === 0 ? 0 : gfExp[gfLog[a] + gfLog[b]];

  // Generate generator polynomial
  const genPoly: number[] = [1];
  for (let i = 0; i < EC_CODEWORDS; i++) {
    const newPoly = new Array(genPoly.length + 1).fill(0);
    for (let j = 0; j < genPoly.length; j++) {
      newPoly[j] ^= genPoly[j];
      newPoly[j + 1] ^= gfMul(genPoly[j], gfExp[i]);
    }
    genPoly.splice(0, genPoly.length, ...newPoly);
  }

  // Divide data polynomial by generator
  const ecWords: number[] = new Array(EC_CODEWORDS).fill(0);
  for (let i = 0; i < dataWords.length; i++) {
    const coeff = dataWords[i] ^ ecWords[0];
    ecWords.shift();
    ecWords.push(0);
    for (let j = 0; j < EC_CODEWORDS; j++) {
      ecWords[j] ^= gfMul(genPoly[j + 1], coeff);
    }
  }

  const allWords = [...dataWords, ...ecWords];

  // ── Build matrix ──
  const matrix: (number | null)[][] = Array.from({ length: N }, () => Array(N).fill(null));
  const reserved: boolean[][] = Array.from({ length: N }, () => Array(N).fill(false));

  // Finder patterns + separators
  const placeFinderPattern = (row: number, col: number) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        const rr = row + r, cc = col + c;
        if (rr < 0 || rr >= N || cc < 0 || cc >= N) continue;
        reserved[rr][cc] = true;
        if (r === -1 || r === 7 || c === -1 || c === 7) {
          matrix[rr][cc] = 0; // separator
        } else if (r === 0 || r === 6 || c === 0 || c === 6) {
          matrix[rr][cc] = 1;
        } else if (r >= 2 && r <= 4 && c >= 2 && c <= 4) {
          matrix[rr][cc] = 1;
        } else {
          matrix[rr][cc] = 0;
        }
      }
    }
  };
  placeFinderPattern(0, 0);
  placeFinderPattern(0, N - 7);
  placeFinderPattern(N - 7, 0);

  // Timing patterns
  for (let i = 8; i < N - 8; i++) {
    reserved[6][i] = true; reserved[i][6] = true;
    matrix[6][i] = i % 2 === 0 ? 1 : 0;
    matrix[i][6] = i % 2 === 0 ? 1 : 0;
  }

  // Dark module
  matrix[N - 8][8] = 1;
  reserved[N - 8][8] = true;

  // Reserve format info
  for (let i = 0; i < 8; i++) {
    reserved[8][i] = true; reserved[8][N - 1 - i] = true;
    reserved[i][8] = true; reserved[N - 1 - i][8] = true;
  }
  reserved[8][8] = true;

  // ── Place data ──
  let bitIdx = 0;
  const getBit = (): number => {
    if (bitIdx >= allWords.length * 8) return 0;
    const w = Math.floor(bitIdx / 8);
    const b = 7 - (bitIdx % 8);
    bitIdx++;
    return (allWords[w] >> b) & 1;
  };

  let col = N - 1;
  let dir = -1; // upward
  while (col >= 0) {
    if (col === 6) col--; // skip timing column
    const startRow = dir === -1 ? N - 1 : 0;
    const endRow = dir === -1 ? -1 : N;
    for (let row = startRow; row !== endRow; row += dir) {
      for (let c = 0; c < 2; c++) {
        const cc = col - c;
        if (cc < 0 || cc >= N) continue;
        if (reserved[row][cc]) continue;
        matrix[row][cc] = getBit();
      }
    }
    col -= 2;
    dir = -dir;
  }

  // ── Apply mask pattern 0 (checkerboard) ──
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!reserved[r][c]) {
        if ((r + c) % 2 === 0) matrix[r][c] = (matrix[r][c] as number) ^ 1;
      }
    }
  }

  // ── Write format info (ECC M, mask 0) ──
  const formatBits = 0x5412; // precomputed for M/0
  for (let i = 0; i < 6; i++) matrix[8][i] = (formatBits >> (14 - i)) & 1;
  matrix[8][7] = (formatBits >> 8) & 1;
  matrix[8][8] = (formatBits >> 7) & 1;
  matrix[7][8] = (formatBits >> 6) & 1;
  for (let i = 0; i < 6; i++) matrix[5 - i][8] = (formatBits >> i) & 1;
  for (let i = 0; i < 8; i++) matrix[N - 1 - i][8] = (formatBits >> (14 - i)) & 1;
  for (let i = 0; i < 7; i++) matrix[8][N - 7 + i] = (formatBits >> i) & 1;

  // ── Render to SVG ──
  const margin = 4;
  const totalModules = N + margin * 2;
  const scale = size / totalModules;
  const rects: string[] = [];
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (matrix[r][c] === 1) {
        const x = (c + margin) * scale;
        const y = (r + margin) * scale;
        rects.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${scale.toFixed(1)}" height="${scale.toFixed(1)}"/>`);
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" shape-rendering="crispEdges">
<rect width="${size}" height="${size}" fill="#fff"/>
${rects.join('\n')}
</svg>`;
}

export function renderPairingContent(state: SidebarState): string {
  const p = state.pairing;
  const isPaired = state.deviceStatus === 'paired';
  const isWaiting = p?.status === 'waiting';
  const method = p?.method || 'code';
  const codeDigits = p?.code || '--- ---';
  const codeExpires = p?.expiresAt || 0;
  const platform = p?.platform || 'wechat';
  const isFeishu = platform === 'feishu';
  const feishuAppId = state.feishuAppId || '';
  const hasFeishu = !!feishuAppId;
  const hasPartialCreds = !!(state.deviceId || state.deviceSecret);
  const platName = isFeishu ? 'Feishu' : 'WeChat';

  // When paired, collapse to a compact connected card (no code/QR clutter)
  if (isPaired) {
    return `<div class="paired-compact">
      <div class="paired-row">
        <div class="paired-icon">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </div>
        <div class="paired-text">
          <div class="paired-title">Connected via ${platName}</div>
          <div class="paired-sub">${platName} Mini Program</div>
        </div>
        <button class="btn btn-sm btn-danger" data-action="unpairDevice" style="margin-left:auto">Unpair</button>
      </div>
    </div>`;
  }

  // Generate both QR SVGs so JS can switch client-side without round-trip
  const wechatQrSvg = p?.code ? generateQrSvg(p.code, 160) : '';
  const feishuQrSvg = p?.code && feishuAppId
    ? generateQrSvg(`feishu://app/${feishuAppId}/pages/login/login?code=${p.code}`, 160)
    : '';
  const hasQr = !!(wechatQrSvg || feishuQrSvg);

  const feishuToggleHtml = hasFeishu ? `<div class="platform-toggle">
    <div class="plat-opt${platform === 'wechat' ? ' active' : ''}" data-platform="wechat">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 22H5a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2h-4m-4 0v-4m0 4h4m0-4H9m0 0v-6a4 4 0 0 1 6-3.3"/></svg>
      WeChat
    </div>
    <div class="plat-opt${platform === 'feishu' ? ' active' : ''}" data-platform="feishu">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
      Feishu
    </div>
  </div>` : '';

  return `<div class="pairing-methods">
    ${feishuToggleHtml}
    <div class="method-option ${method === 'code' ? 'active' : ''}" data-method="code">
      <div class="method-header" data-toggle="code">
        <div class="method-radio"></div>
        <div>
          <div class="method-label">Code Pairing</div>
          <div class="method-hint">Enter this code in your <span class="plat-label">${platName}</span> Mini Program</div>
        </div>
      </div>
      <div class="method-body" style="${method === 'code' ? 'max-height:300px;padding:0 10px 12px' : ''}">
        <div class="code-display-wrap">
          <div class="code-digits" id="codeDigits" data-expires="${codeExpires}">${h(codeDigits)}</div>
          <div class="code-timer" id="codeTimer">Code expires in <span id="countdown">5:00</span></div>
          <div class="code-actions">
            <button class="btn btn-sm btn-ghost" data-action="regeneratePairingCode">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
              Regenerate
            </button>
            ${hasPartialCreds ? '<button class="btn btn-sm btn-ghost" data-action="unpairDevice">Reset</button>' : ''}
          </div>
          <div class="pairing-status ${isPaired ? 'success' : isWaiting ? 'waiting' : ''}" id="pairingStatus">
            ${isPaired ? `Connected via ${platName}` : isWaiting ? (p?.statusText || 'Waiting for scan...') : 'Generate a code to pair'}
          </div>
        </div>
      </div>
    </div>
    <div class="method-option ${method === 'qr' ? 'active' : ''}" data-method="qr">
      <div class="method-header" data-toggle="qr">
        <div class="method-radio"></div>
        <div>
          <div class="method-label">QR Scan</div>
          <div class="method-hint">Scan with <span class="plat-label">${platName}</span> to pair instantly</div>
        </div>
      </div>
      <div class="method-body" style="${method === 'qr' ? 'max-height:300px;padding:0 10px 12px' : ''}">
        <div class="qr-layout">
          <div class="qr-visual" id="qrVisual">
            ${!hasQr
              ? '<div style="width:160px;height:160px;display:flex;align-items:center;justify-content:center;color:#50506e;font-size:12px">Generate a code first</div>'
              : `<div id="qrWechat" style="display:${isFeishu ? 'none' : 'block'}">${wechatQrSvg}</div>`
                + (feishuQrSvg ? `<div id="qrFeishu" style="display:${isFeishu ? 'block' : 'none'}">${feishuQrSvg}</div>` : '')
            }
          </div>
          <div class="qr-side">
            <div class="hint">Scan with your <strong>${platName} Mini Program</strong></div>
            <div class="qr-bottom">
              <div class="qr-status ${isPaired ? 'success' : ''}" id="qrStatus">
                ${isPaired ? 'Paired successfully!' : 'Generate a code first'}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>`;
}

function renderPairing(state: SidebarState): string {
  const { deviceStatus, pairing } = state;
  const isPaired = deviceStatus === 'paired';
  const pn = pairing?.platform === 'feishu' ? 'Feishu' : 'WeChat';
  return `<div class="card pairing-card">
    <div class="card-header">
      <span class="card-label">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5l7 7-7 7"/></svg>
        Pairing
      </span>
      <span class="tag ${isPaired ? 'green' : 'orange'}" id="pairingHeaderTag">${isPaired ? '<span class="dot green"></span>' + pn : '<span class="dot orange pulse"></span>' + pn}</span>
    </div>
    <div id="pairingContent">${renderPairingContent(state)}</div>
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
${renderSubscribe()}
<script nonce="${NONCE}">
(function() {
  var api = acquireVsCodeApi();

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
          api.postMessage({ action: 'pairedDevice', token: token, deviceId: deviceId });
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
  var _lastHtml = { deviceContent: '', pairingContent: '', agentsContent: '', approvalsContent: '', sessionsContent: '' };
  function swap(id, html) {
    if (html === undefined) return false;
    if (_lastHtml[id] === html) return false;
    var el = document.getElementById(id);
    if (!el) return false;
    el.innerHTML = html;
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
      applySavedPlatform();
      swap('agentsContent', d.agentsHtml);
      swap('approvalsContent', d.approvalsHtml);
      if (swap('sessionsContent', d.sessionsHtml)) applyAgentFilter();
      // Update badges
      if (d.agentCount !== undefined) {
        var ab = document.getElementById('agentsBadge');
        if (ab) { ab.textContent = d.agentCount + ' active'; ab.className = 'badge' + (d.agentCount > 0 ? ' green' : ''); }
      }
      if (d.approvalCount !== undefined) {
        var apb = document.getElementById('approvalsBadge');
        if (apb) { apb.textContent = d.approvalCount + ' pending'; apb.className = 'badge' + (d.approvalCount > 0 ? ' orange' : ''); }
      }
      // Update device status tag
      if (d.deviceStatus !== undefined) {
        var ds = document.getElementById('deviceStatusTag');
        if (ds) {
          if (d.deviceStatus === 'paired') { ds.textContent = '● Online'; ds.className = 'tag green'; }
          else if (d.deviceStatus === 'offline') { ds.textContent = '● Offline'; ds.className = 'tag red'; }
          else { ds.textContent = '● Not paired'; ds.className = 'tag orange'; }
        }
      }
      // Update pairing header
      if (d.paired !== undefined) {
        var pt = document.getElementById('pairingHeaderTag');
        if (pt) {
          var _pn = 'WeChat';
          try { var _sp = sessionStorage.getItem('pairingPlatform'); if (_sp) _pn = _sp === 'feishu' ? 'Feishu' : 'WeChat'; } catch(e) {}
          if (d.paired) { pt.innerHTML = '<span class="dot green"></span>' + _pn; pt.className = 'tag green'; }
          else { pt.innerHTML = '<span class="dot orange pulse"></span>' + _pn; pt.className = 'tag orange'; }
        }
      }
      // Update PD so openPairingWs uses fresh data
      if (d.relayUrl) PD.relayUrl = d.relayUrl;
      if (d.deviceId) PD.deviceId = d.deviceId;
      if (d.deviceSecret) PD.deviceSecret = d.deviceSecret;
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
  });

  // Pairing method toggle (local UI only)
  document.addEventListener('click', function(e) {
    var toggle = e.target.closest('.method-header');
    if (toggle) {
      var opt = toggle.closest('.method-option');
      if (!opt) return;
      document.querySelectorAll('.method-option').forEach(function(o) { o.classList.remove('active'); });
      opt.classList.add('active');
      try { sessionStorage.setItem('pairingMethod', opt.dataset.method); } catch(e) {}
      return;
    }
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
    // Platform toggle (WeChat / Feishu)
    var plat = e.target.closest('.plat-opt');
    if (plat) {
      var platform = plat.dataset.platform;
      document.querySelectorAll('.plat-opt').forEach(function(p) { p.classList.toggle('active', p.dataset.platform === platform); });
      var isFeishu = platform === 'feishu';
      var qrW = document.getElementById('qrWechat');
      var qrF = document.getElementById('qrFeishu');
      if (qrW) qrW.style.display = isFeishu ? 'none' : 'block';
      if (qrF) qrF.style.display = isFeishu ? 'block' : 'none';
      var name = isFeishu ? 'Feishu' : 'WeChat';
      document.querySelectorAll('.plat-label').forEach(function(el) { el.textContent = name; });
      // Update header badge (only when not paired)
      var pt = document.getElementById('pairingHeaderTag');
      if (pt && !/green/.test(pt.className)) {
        pt.innerHTML = '<span class="dot orange pulse"></span>' + name;
      }
      try { sessionStorage.setItem('pairingPlatform', platform); } catch(e) {}
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
    var matching: HTMLElement[] = [];
    items.forEach(function(it) {
      var el = it as HTMLElement;
      var ag = el.dataset.agent || 'claude-code';
      var match = (key === 'all') || (ag === key);
      // Reset — remove both class and inline
      el.classList.remove('session-hidden');
      el.style.display = '';
      if (!match) {
        el.style.display = 'none';
      } else {
        matching.push(el);
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
  function applySavedPlatform() {
    var saved;
    try { saved = sessionStorage.getItem('pairingPlatform'); } catch(e) {}
    var platform = saved || 'wechat';
    var toggles = document.querySelectorAll('.plat-opt');
    if (toggles.length === 0) return; // no platform toggle (feishuAppId not configured)
    var isFeishu = platform === 'feishu';
    toggles.forEach(function(t) { t.classList.toggle('active', t.dataset.platform === platform); });
    var qrW = document.getElementById('qrWechat');
    var qrF = document.getElementById('qrFeishu');
    if (qrW) qrW.style.display = isFeishu ? 'none' : 'block';
    if (qrF) qrF.style.display = isFeishu ? 'block' : 'none';
    var name = isFeishu ? 'Feishu' : 'WeChat';
    document.querySelectorAll('.plat-label').forEach(function(el) { el.textContent = name; });
    // Update header tag if not paired (when paired, extension host sends correct text)
    var pt = document.getElementById('pairingHeaderTag');
    if (pt && !/green/.test(pt.className)) {
      pt.innerHTML = '<span class="dot orange pulse"></span>' + name;
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
  try {
    var saved = sessionStorage.getItem('pairingMethod');
    if (saved) {
      var savedOpt = document.querySelector('.method-option[data-method="' + saved + '"]');
      if (savedOpt) {
        document.querySelectorAll('.method-option').forEach(function(o) { o.classList.remove('active'); });
        savedOpt.classList.add('active');
      }
    }
  } catch(e) {}

  // Restore saved platform preference
  applySavedPlatform();

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
      api.postMessage({
        action: action,
        sessionId: target.dataset.sessionId,
        attached: target.dataset.attached === 'true',
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

    api.postMessage({ action: action });
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
  text-align:center;padding:20px 16px 16px;
  position:relative;
}
.brand::after{
  content:'';position:absolute;bottom:0;left:50%;transform:translateX(-50%);
  width:40px;height:1px;
  background:linear-gradient(90deg,transparent,var(--vscode-textLink-foreground,#00ffe0),transparent);
}
.brand-icon{
  display:inline-flex;align-items:center;justify-content:center;
  width:36px;height:36px;margin-bottom:8px;
  background:var(--vscode-sideBar-background,#181824);
  border:1px solid var(--vscode-panel-border,#1e1e2e);
  border-radius:10px;position:relative;
}
.brand-icon svg{width:20px;height:20px;color:var(--vscode-textLink-foreground,#00ffe0)}
.brand-glow{
  position:absolute;inset:-2px;border-radius:12px;
  background:linear-gradient(135deg,var(--vscode-textLink-foreground,#00ffe0),var(--vscode-textLink-foreground,#7c5cfc));
  opacity:.06;z-index:-1;
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
.approval-item{
  display:flex;align-items:center;justify-content:space-between;gap:6px;
  padding:4px 8px;margin-left:4px;
  border-left:2px solid #f5a623;
  overflow:hidden;
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
.session-title-row .btn{flex-shrink:0}
.btn-attached{
  background:rgba(46,204,113,.12);border-color:rgba(46,204,113,.3);color:#2ecc71;
}
.btn-attached:hover{background:rgba(46,204,113,.2);border-color:#2ecc71}
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
   MISC
   ═══════════════════════════════════════════════ */
.empty-state{font-size:11px;color:var(--vscode-descriptionForeground,#50506e);text-align:center;padding:8px 0}
.footer{text-align:center;padding:12px 0 8px;font-size:9px;color:var(--vscode-descriptionForeground,#50506e);letter-spacing:.04em}

/* ═══════════════════════════════════════════════
   PAIRING CARD
   ═══════════════════════════════════════════════ */
.pairing-card{
  border-color:rgba(0,255,224,.12);
  background:linear-gradient(135deg,rgba(0,255,224,.02),transparent 60%);
}
.pairing-methods{display:flex;flex-direction:column;gap:8px}
.platform-toggle{display:flex;gap:4px;padding:0 2px 2px}
.plat-opt{
  display:inline-flex;align-items:center;gap:4px;
  padding:4px 10px;border-radius:6px;font-size:10px;font-weight:500;
  background:var(--vscode-sideBar-background,#0f0f18);
  border:1px solid var(--vscode-panel-border,#1e1e2e);
  color:var(--vscode-descriptionForeground,#50506e);
  cursor:pointer;transition:all .2s;user-select:none;
}
.plat-opt svg{width:10px;height:10px;opacity:.6}
.plat-opt:hover{color:var(--vscode-editor-foreground);border-color:var(--vscode-descriptionForeground,#50506e)}
.plat-opt.active{
  background:rgba(0,255,224,.08);color:var(--vscode-textLink-foreground,#00ffe0);
  border-color:rgba(0,255,224,.2);
}
.plat-opt.active svg{opacity:1}
.plat-label{font-weight:600}
.method-option{
  background:var(--vscode-sideBar-background,#0f0f18);
  border:1px solid var(--vscode-panel-border,#1e1e2e);
  border-radius:8px;overflow:hidden;
  transition:border-color .2s;
}
.method-option.active{border-color:rgba(0,255,224,.2)}
.method-header{
  display:flex;align-items:center;gap:8px;padding:8px 10px;
  cursor:pointer;user-select:none;
}
.method-radio{
  width:14px;height:14px;border-radius:50%;
  border:2px solid var(--vscode-descriptionForeground,#50506e);
  display:flex;align-items:center;justify-content:center;
  flex-shrink:0;transition:all .2s;
}
.method-option.active .method-radio{
  border-color:var(--vscode-textLink-foreground,#00ffe0);
}
.method-option.active .method-radio::after{
  content:'';width:7px;height:7px;border-radius:50%;
  background:var(--vscode-textLink-foreground,#00ffe0);
}
.method-label{font-size:12px;font-weight:500;color:var(--vscode-editor-foreground);flex:1}
.method-hint{font-size:10px;color:var(--vscode-descriptionForeground,#50506e)}
.method-body{max-height:0;overflow:hidden;padding:0 10px;transition:max-height .3s ease,padding .3s ease}
.method-option.active .method-body{max-height:300px;padding:0 10px 12px}
.code-display-wrap{text-align:center;padding:8px 0 4px}
.code-digits{
  font-family:Georgia,'Times New Roman',serif;font-weight:800;
  font-size:32px;letter-spacing:.15em;
  color:var(--vscode-textLink-foreground,#00ffe0);
  text-shadow:0 0 30px rgba(0,255,224,.12);
  line-height:1.1;
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
.qr-layout{display:flex;gap:12px;align-items:flex-start;margin-top:2px}
.qr-visual{flex-shrink:0;background:var(--vscode-sideBar-background,#07070c);border-radius:6px;border:1px solid var(--vscode-panel-border,#1e1e2e);padding:6px}
.qr-visual svg{width:90px;height:90px;display:block}
.qr-side{flex:1;display:flex;flex-direction:column;gap:6px}
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
   ANIMATIONS
   ═══════════════════════════════════════════════ */
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.card{animation:fadeIn .4s cubic-bezier(.4,0,.2,1) both}
.card:nth-child(2){animation-delay:.05s}
.card:nth-child(3){animation-delay:.1s}
.card:nth-child(4){animation-delay:.15s}
.card:nth-child(5){animation-delay:.2s}
.card:nth-child(6){animation-delay:.25s}
`;
