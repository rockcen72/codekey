import { Link } from 'react-router-dom';
import type { UserSession } from '../api/types';
import { formatDate } from '../utils/format';
import { DeviceBadge } from './DeviceBadge';

interface Props {
  session: UserSession;
}

export function SessionCard({ session }: Props) {
  const title = session.metadata.title || session.metadata.cwd || session.metadata.claudeSessionId || session.id;
  return (
    <Link className="session-card" to={`/sessions/${session.id}`}>
      <div className="session-card-top">
        <DeviceBadge name={session.device_name} deviceId={session.device_id} />
        <span className={`status-dot status-${session.status}`}>{session.status}</span>
      </div>
      <div className="session-title">{title}</div>
      <div className="session-meta">
        <span>{session.agent_type}</span>
        <span>{formatDate(session.last_active_at)}</span>
      </div>
      {session.pending_count > 0 ? <div className="pending-count">{session.pending_count} 个待处理请求</div> : null}
    </Link>
  );
}
