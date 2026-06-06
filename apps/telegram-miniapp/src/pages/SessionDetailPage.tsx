import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { userRequest } from '../api/client';
import type { UserEvent, UserSession } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { DeviceBadge } from '../components/DeviceBadge';
import { formatDate } from '../utils/format';

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
        {events.map((event) => (
          <article className="event-row" key={event.id}>
            <div>
              <strong>{event.type}</strong>
              <p>{formatDate(event.created_at)}</p>
            </div>
            {event.pending ? <span className="pending-count">审批功能即将上线</span> : <span>{event.decision || '已记录'}</span>}
          </article>
        ))}
      </section>
    </main>
  );
}
