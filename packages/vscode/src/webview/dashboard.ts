import * as vscode from 'vscode';
import { showWebView, createHtml } from './panel.js';
import { createApi, ApiError, type SessionResponse, type EventResponse } from '../api/client.js';
import type { Credentials } from '../auth/credentials.js';

interface DashboardData {
  status: 'paired' | 'unpaired' | 'offline';
  sessions: SessionResponse[];
  events: Record<string, EventResponse[]>;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export async function showDashboardView(
  context: vscode.ExtensionContext,
  creds: Credentials,
): Promise<vscode.WebviewPanel> {
  const panel = showWebView(context, 'CodeKey: Dashboard', '<p>Loading...</p>');
  await refreshDashboard(panel, creds);
  return panel;
}

export async function refreshDashboard(
  panel: vscode.WebviewPanel,
  creds: Credentials,
): Promise<void> {
  let data: DashboardData;

  try {
    const api = createApi(creds);
    let sessions: SessionResponse[];
    try {
      sessions = await api.getSessions();
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        data = { status: 'unpaired', sessions: [], events: {} };
        panel.webview.html = renderDashboardHtml(data);
        return;
      }
      sessions = [];
    }

    const events: Record<string, EventResponse[]> = {};
    await Promise.all(sessions.map(async (s) => {
      events[s.id] = await api.getSessionEvents(s.id).catch(() => []);
    }));

    data = { status: 'paired', sessions, events };
  } catch {
    data = { status: 'offline', sessions: [], events: {} };
  }

  panel.webview.html = renderDashboardHtml(data);
}

function renderDashboardHtml(data: DashboardData): string {
  const statusText = data.status === 'paired' ? '✅ Paired'
    : data.status === 'unpaired' ? '⚠️ Auth expired — re-pair your device'
    : '❌ Offline';

  const sessionsHtml = data.sessions.length === 0
    ? '<p>No active sessions. Use <b>CodeKey: Start Claude Code</b> to begin.</p>'
    : '<table><tr><th>Agent</th><th>Status</th><th>Events</th><th>Started</th></tr>'
      + data.sessions.map(s => {
        const ev = data.events[s.id] ?? [];
        const pending = ev.filter(e => e.pending).length;
        return `<tr>
          <td>${escapeHtml(s.agent_type)}</td>
          <td>${escapeHtml(s.status)}${pending > 0 ? ` (${pending} pending)` : ''}</td>
          <td>${ev.length}</td>
          <td>${escapeHtml(new Date(s.created_at).toLocaleString())}</td>
        </tr>`;
      }).join('')
      + '</table>';

  const allEvents = data.sessions.flatMap(s =>
    (data.events[s.id] ?? []).map(e => ({ ...e, agent: s.agent_type }))
  ).sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
   .slice(0, 20);

  const eventsHtml = allEvents.length === 0
    ? '<p>No events yet.</p>'
    : allEvents.map(e => {
      const summary = escapeHtml(e.data?.summary || e.data?.command || e.type);
      const agent = escapeHtml(e.agent);
      const eventType = escapeHtml(e.type);
      const riskLevel = e.risk_level ? ` [${escapeHtml(e.risk_level)}]` : '';
      const decision = e.decision ? `✅ ${escapeHtml(e.decision)}` : '';
      return `<div class="event">
        <div class="time">${escapeHtml(new Date(e.created_at).toLocaleTimeString())} — ${agent} — ${eventType}${riskLevel}</div>
        <div class="summary">${summary}</div>
        <div class="meta">${e.pending ? '⏳ Pending' : decision}</div>
      </div>`;
    }).join('');

  const bodyHtml = `
    <h1>CodeKey Dashboard</h1>
    <div class="status ${data.status}">${statusText}</div>
    <h2>Sessions</h2>
    ${sessionsHtml}
    <h2>Recent Events</h2>
    ${eventsHtml}
  `;

  return createHtml('CodeKey: Dashboard', bodyHtml);
}
