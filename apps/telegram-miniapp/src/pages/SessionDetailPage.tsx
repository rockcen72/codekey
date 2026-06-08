import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { userRequest } from '../api/client';
import type { UserEvent, UserSession } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { DeviceBadge } from '../components/DeviceBadge';
import { formatDate } from '../utils/format';

function EventRow({ event }: { event: UserEvent }) {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const summary = (data.summary as string) || (data.command as string) || '';
  const command = (data.command as string) || '';
  const risk = event.risk_level || (data.risk as string) || null;
  const isInteractive = event.type === 'approval_required' || event.type === 'input_required';

  const typeLabel: Record<string, string> = {
    approval_required: '审批请求',
    input_required: '输入请求',
    user_prompt: '用户指令',
    task_complete: '任务完成',
    session_idle: '会话空闲',
    command_started: '命令执行',
    error: '错误',
  };

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
          <span className={`decision-badge decision-${event.decision}`}>{event.decision}</span>
        ) : null}
        {!event.pending && !event.decision ? <span className="muted">已记录</span> : null}
      </div>
      {isInteractive && event.pending ? <div className="event-hint">审批功能即将上线</div> : null}
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

  useEffect(() => {
    if (!auth.token || !id) return;
    let active = true;
    async function load() {
      try {
        const [nextSession, nextEvents] = await Promise.all([
          userRequest<UserSession>(`/api/v1/user/sessions/${id}`),
          userRequest<UserEvent[]>(`/api/v1/user/sessions/${id}/events`),
        ]);
        if (!active) return;
        setSession(nextSession);
        setEvents(nextEvents);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : '会话加载失败');
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [auth.token, id]);

  return (
    <main className="shell">
      <header className="page-header">
        <button className="ghost-button" type="button" onClick={() => navigate('/')}>返回</button>
        <h1>{session?.metadata.title || '会话详情'}</h1>
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
          <EventRow key={event.id} event={event} />
        ))}
      </section>
    </main>
  );
}
