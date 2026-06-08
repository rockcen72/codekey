import { Link } from 'react-router-dom';
import type { UserSession } from '../api/types';
import { formatDate } from '../utils/format';
import { agentColorClass, agentLabel, sessionShortId, sessionSubtitle, sessionTitle, statusLabel } from '../utils/session-display';

interface Props {
  session: UserSession;
}

export function SessionCard({ session }: Props) {
  const agentClass = agentColorClass(session.agent_type || session.metadata.runtime);
  const shortId = sessionShortId(session);
  const pendingCount = Number(session.pending_count || 0);

  return (
    <Link className={`session-card agent-${agentClass} ${pendingCount > 0 ? 'has-pending' : ''} ${session.status === 'active' ? 'connected' : ''}`} to={`/sessions/${session.id}`}>
      <div className={`conn-bar agent-${agentClass}`} />
      <div className="card-body">
        <div className="card-top">
          <div className="card-title-row">
            <span className="session-title">{sessionTitle(session)}</span>
            <span className={`agent-chip agent-${agentClass}`}>{agentLabel(session.agent_type)}</span>
          </div>
          <span className={`status-dot status-${session.status}`}>{statusLabel(session.status)}</span>
        </div>
        <div className="session-subtitle">{sessionSubtitle(session)}</div>
        <div className="card-footer">
          {shortId ? <span className="session-id mono">{shortId}</span> : null}
          <span className="session-time">{formatDate(session.last_active_at)}</span>
          {pendingCount > 0 ? (
            <span className="pending-count" aria-label={`${pendingCount} pending approvals`}>
              {pendingCount}
            </span>
          ) : null}
        </div>
      </div>
    </Link>
  );
}
