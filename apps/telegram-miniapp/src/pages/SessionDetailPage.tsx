import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { userRequest } from '../api/client';
import type { ApprovalResponseResult, UserEvent, UserSession } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { DeviceBadge } from '../components/DeviceBadge';
import { formatDate } from '../utils/format';

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

function EventRow({ event, onDecision }: { event: UserEvent; onDecision: (eventId: string, decision: string, message?: string) => Promise<void> }) {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const summary = (data.summary as string) || (data.command as string) || '';
  const command = (data.command as string) || '';
  const risk = event.risk_level || (data.risk as string) || null;
  const isInteractive = event.type === 'approval_required' || event.type === 'input_required';
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const allowed = risk ? (ALLOWED_DECISIONS[risk] ?? ['deny', 'pause']) : ['deny', 'pause'];

  const typeLabel: Record<string, string> = {
    approval_required: '审批请求',
    input_required: '输入请求',
    user_prompt: '用户指令',
    task_complete: '任务完成',
    session_idle: '会话空闲',
    command_started: '命令执行',
    error: '错误',
  };

  async function handleDecision(decision: string) {
    setBusy(decision);
    try {
      await onDecision(event.id, decision, decision === 'reply' ? replyText : undefined);
    } finally {
      setBusy(null);
    }
  }

  return (
    <article className={`event-row${event.pending ? ' event-pending' : ''}`}>
      <div className="event-header">
        <span className={`event-type event-type-${event.type}`}>{typeLabel[event.type] || event.type}</span>
        {risk ? <span className={`risk-badge risk-${risk}`}>{risk}</span> : null}
        {event.pending ? <span className="pending-badge">待处理</span> : null}
      </div>
      {summary ? <div className="event-summary">{summary}</div> : null}
      {command && command !== summary ? <div className="event-command"><code>{command}</code></div> : null}
      <div className="event-footer">
        <span className="event-time">{formatDate(event.created_at)}</span>
        {!event.pending && event.decision ? (
          <span className={`decision-badge decision-${event.decision}`}>{DECISION_LABEL[event.decision] || event.decision}</span>
        ) : null}
        {!event.pending && !event.decision ? <span className="muted">已记录</span> : null}
      </div>
      {isInteractive && event.pending ? (
        <div className="approval-actions">
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
            {allowed.filter((d) => !(event.type === 'input_required' && d === 'reply')).map((d) => (
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

interface Props {
  auth: AuthState;
}

export function SessionDetailPage({ auth }: Props) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<UserSession | null>(null);
  const [events, setEvents] = useState<UserEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!auth.token || !id) return;
    try {
      const [nextSession, nextEvents] = await Promise.all([
        userRequest<UserSession>(`/api/v1/user/sessions/${id}`),
        userRequest<UserEvent[]>(`/api/v1/user/sessions/${id}/events`),
      ]);
      setSession(nextSession);
      setEvents(nextEvents);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '会话加载失败');
    }
  }, [auth.token, id]);

  useEffect(() => {
    let active = true;
    void load().then(() => { if (!active) return; });
    return () => { active = false; };
  }, [load]);

  const handleDecision = useCallback(async (eventId: string, decision: string, message?: string) => {
    try {
      await userRequest<ApprovalResponseResult>(`/api/v1/events/${eventId}/approval-response`, {
        method: 'POST',
        body: JSON.stringify({ decision, message }),
      });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '审批操作失败');
    }
  }, [load]);

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
        {events.length === 0 ? <div className="notice">暂无事件记录</div> : null}
        {events.map((event) => (
          <EventRow key={event.id} event={event} onDecision={handleDecision} />
        ))}
      </section>
    </main>
  );
}
