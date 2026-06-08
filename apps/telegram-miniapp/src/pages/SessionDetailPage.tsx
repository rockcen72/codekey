import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { userRequest } from '../api/client';
import type { ApprovalResponseResult, UserEvent, UserSession } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { DeviceBadge } from '../components/DeviceBadge';
import { formatDate } from '../utils/format';

// ── Constants ───────────────────────────────────────

const POLL_INTERVAL = 10_000;

const ALLOWED_EVENT_TYPES = new Set([
  'user_prompt',
  'command_started',
  'task_complete',
  'approval_required',
  'input_required',
  'error',
  'session_idle',
]);

const ALLOWED_DECISIONS: Record<string, string[]> = {
  low: ['approve', 'deny', 'pause', 'reply'],
  medium: ['approve', 'deny', 'pause', 'reply'],
  high: ['deny', 'pause', 'reply'],
  critical: ['deny', 'pause'],
  unknown: ['deny', 'pause', 'reply'],
};

const DECISION_LABEL: Record<string, string> = {
  approve: '批准',
  deny: '拒绝',
  pause: '暂停',
  reply: '回复',
};

// ── Toast (lightweight) ─────────────────────────────

function showToast(msg: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 300);
  }, 2000);
}

// ── EventRow ────────────────────────────────────────

function EventRow({ event, resolvedDecision, onDecision }: {
  event: UserEvent;
  resolvedDecision?: string;
  onDecision: (eventId: string, decision: string, message?: string) => Promise<void>;
}) {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const summary = (data.summary as string) || (data.command as string) || '';
  const command = (data.command as string) || '';
  const risk = event.risk_level || (data.risk as string) || null;
  const isInteractive = event.type === 'approval_required' || event.type === 'input_required';
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const allowed = risk ? (ALLOWED_DECISIONS[risk] ?? ['deny', 'pause']) : ['deny', 'pause'];
  const isHighRisk = risk === 'high' || risk === 'critical';

  // Use resolvedDecision (optimistic or stale-pending) if event is still pending in data
  const effectiveDecision = resolvedDecision ?? event.decision;
  const effectivePending = event.pending && !resolvedDecision;

  async function handleDecision(decision: string) {
    setBusy(decision);
    try {
      await onDecision(event.id, decision, decision === 'reply' ? replyText : undefined);
    } finally {
      setBusy(null);
    }
  }

  // session_idle: centered system marker
  if (event.type === 'session_idle') {
    return (
      <div className="event-system">
        <span className="event-system-text">AI 代理等待指令中...</span>
        <span className="event-system-time">{formatDate(event.created_at)}</span>
      </div>
    );
  }

  // command_started: AI card with RUNNING badge
  if (event.type === 'command_started') {
    return (
      <article className="event-row">
        <div className="event-header">
          <span className="event-type event-type-command_started">命令执行</span>
          <span className="kind-badge kind-badge-running">RUNNING</span>
        </div>
        <div className="event-summary">电脑端已接收，正在交给 Agent 处理...</div>
        {command ? <div className="event-command"><code>{command}</code></div> : null}
        <div className="event-footer">
          <span className="event-time">{formatDate(event.created_at)}</span>
        </div>
      </article>
    );
  }

  return (
    <article className={`event-row${effectivePending ? ' event-pending' : ''}`}>
      <div className="event-header">
        {event.type === 'approval_required' ? <span className="event-type event-type-approval_required">审批请求</span> : null}
        {event.type === 'input_required' ? <span className="event-type event-type-input_required">输入请求</span> : null}
        {event.type === 'user_prompt' ? <span className="event-type event-type-user_prompt">用户指令</span> : null}
        {event.type === 'task_complete' ? <span className="event-type event-type-task_complete">任务完成</span> : null}
        {event.type === 'error' ? <span className="event-type event-type-error">错误</span> : null}
        {event.type === 'task_complete' ? <span className="kind-badge kind-badge-done">DONE</span> : null}
        {event.type === 'input_required' && effectivePending ? <span className="kind-badge kind-badge-input">INPUT</span> : null}
        {risk ? <span className={`risk-badge risk-${risk}`}>{risk}</span> : null}
        {effectivePending ? <span className="pending-badge">待处理</span> : null}
      </div>
      {summary ? <div className="event-summary">{summary}</div> : null}
      {command && command !== summary ? <div className="event-command"><code>{command}</code></div> : null}
      <div className="event-footer">
        <span className="event-time">{formatDate(event.created_at)}</span>
        {!effectivePending && effectiveDecision ? (
          <span className={`decision-badge decision-${effectiveDecision}`}>{DECISION_LABEL[effectiveDecision] || effectiveDecision}</span>
        ) : null}
        {!effectivePending && !effectiveDecision ? <span className="muted">已记录</span> : null}
      </div>

      {/* Approval actions */}
      {isInteractive && effectivePending ? (
        <div className="approval-actions">
          {isHighRisk ? (
            <div className="high-risk-notice">风险较高，请在电脑端确认后处理</div>
          ) : null}
          {event.type === 'input_required' ? (
            <div className="reply-row">
              <input
                className="reply-input"
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="输入回复内容..."
              />
              <button
                className="primary-button btn-sm"
                type="button"
                disabled={!replyText.trim() || busy !== null}
                onClick={() => void handleDecision('reply')}
              >
                {busy === 'reply' ? '发送中' : '回复'}
              </button>
            </div>
          ) : null}
          <div className="decision-buttons">
            {allowed
              .filter((d) => !(event.type === 'input_required' && d === 'reply'))
              .filter((d) => !(isHighRisk && d === 'approve'))
              .map((d) => (
                <button
                  key={d}
                  className={`ghost-button btn-sm decision-btn decision-btn-${d}`}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleDecision(d)}
                >
                  {busy === d ? '...' : DECISION_LABEL[d] || d}
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ── SessionDetailPage ───────────────────────────────

interface Props {
  auth: AuthState;
}

export function SessionDetailPage({ auth }: Props) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<UserSession | null>(null);
  const [events, setEvents] = useState<UserEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resolvedMap, setResolvedMap] = useState<Map<string, string>>(new Map());
  const loadingRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    if (!auth.token || !id || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [nextSession, nextEvents] = await Promise.all([
        userRequest<UserSession>(`/api/v1/user/sessions/${id}`),
        userRequest<UserEvent[]>(`/api/v1/user/sessions/${id}/events`),
      ]);

      // Stale pending detection: mark previously-pending events that are now resolved
      setEvents(prev => {
        const prevPending = prev.filter(e => e.pending);
        const nextMap = new Map(nextEvents.map(e => [e.id, e]));
        for (const old of prevPending) {
          const fresh = nextMap.get(old.id);
          if (fresh && !fresh.pending && !fresh.decision) {
            // Server resolved it but no decision recorded — mark locally
            setResolvedMap(prev => {
              if (prev.has(old.id)) return prev;
              const next = new Map(prev);
              next.set(old.id, 'resolved');
              return next;
            });
          }
        }
        return nextEvents;
      });

      // Clean resolvedMap for events confirmed by server
      setResolvedMap(prev => {
        const next = new Map(prev);
        for (const [eid] of next) {
          const fresh = nextEvents.find(e => e.id === eid);
          if (fresh && !fresh.pending) next.delete(eid);
        }
        return next;
      });

      setSession(nextSession);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '会话加载失败');
    } finally {
      loadingRef.current = false;
    }
  }, [auth.token, id]);

  // Initial fetch
  useEffect(() => {
    void load();
  }, [load]);

  // 10s polling + visibilitychange
  useEffect(() => {
    if (!auth.token || !id) return;

    function startPoll() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => void load(), POLL_INTERVAL);
    }
    function stopPoll() {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    function onVisibility() {
      if (document.hidden) stopPoll();
      else { void load(); startPoll(); }
    }

    startPoll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [auth.token, id, load]);

  // Approval handler with optimistic UI + toast errors
  const handleDecision = useCallback(async (eventId: string, decision: string, message?: string) => {
    // Optimistic: mark resolved locally
    setResolvedMap(prev => new Map(prev).set(eventId, decision));

    try {
      await userRequest<ApprovalResponseResult>(`/api/v1/events/${eventId}/approval-response`, {
        method: 'POST',
        body: JSON.stringify({ decision, message }),
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '审批操作失败';
      // Toast for known errors, banner for unknown
      if (msg.includes('ALREADY_RESPONDED') || msg.includes('BRIDGE_NOT_CONNECTED') || msg.includes('RISK_TOO_HIGH')) {
        const label = msg.includes('ALREADY_RESPONDED') ? '审批已处理'
          : msg.includes('BRIDGE_NOT_CONNECTED') ? '桌面端未连接'
          : '风险过高，不能批准';
        showToast(label);
        // Re-fetch to get authoritative state
        await load();
      } else {
        setError(msg);
      }
    }
  }, [load]);

  // Filter to allowed event types
  const filteredEvents = events.filter(e => ALLOWED_EVENT_TYPES.has(e.type));

  return (
    <main className="shell">
      <header className="page-header">
        <button className="ghost-button" type="button" onClick={() => navigate('/')}>返回</button>
        <h1>{session?.metadata.title || '会话详情'}</h1>
        <button className="ghost-button" type="button" onClick={() => void load()}>刷新</button>
      </header>
      {error ? <div className="notice error-text">{error}</div> : null}
      {session ? (
        <section className="detail-panel">
          <div className="session-meta">
            <DeviceBadge name={session.device_name} deviceId={session.device_id} />
            <span>{formatDate(session.last_active_at)}</span>
          </div>
          <pre>{JSON.stringify(session.metadata, null, 2)}</pre>
        </section>
      ) : null}
      <section className="event-list">
        {filteredEvents.length === 0 ? <div className="notice">暂无事件记录</div> : null}
        {filteredEvents.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            resolvedDecision={resolvedMap.get(event.id)}
            onDecision={handleDecision}
          />
        ))}
      </section>
    </main>
  );
}
