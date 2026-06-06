import { Link } from 'react-router-dom';
import { SessionCard } from '../components/SessionCard';
import type { AuthState } from '../hooks/useAuth';
import { useDevices } from '../hooks/useDevices';
import { useSessions } from '../hooks/useSessions';

interface Props {
  auth: AuthState;
}

export function SessionsPage({ auth }: Props) {
  const enabled = !!auth.token && !auth.loading;
  const devices = useDevices(enabled);
  const sessions = useSessions(enabled);

  return (
    <main className="shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">CodeKey Telegram Gateway</p>
          <h1>会话</h1>
        </div>
        <button className="ghost-button" type="button" onClick={() => void sessions.refresh()}>刷新</button>
      </header>

      {devices.loading || sessions.loading ? <div className="notice">加载中</div> : null}
      {devices.error || sessions.error ? <div className="notice error-text">{devices.error || sessions.error}</div> : null}

      {!devices.loading && devices.devices.length === 0 ? (
        <section className="empty-state">
          <h2>还没有绑定设备</h2>
          <p>在桌面端生成配对码后，在这里完成绑定。</p>
          <Link className="primary-button link-button" to="/bind">绑定设备</Link>
        </section>
      ) : (
        <>
          <div className="summary-row">
            <span>{devices.devices.length} 台设备</span>
            <Link to="/bind">新增绑定</Link>
          </div>
          <section className="session-list">
            {sessions.sessions.length > 0 ? (
              sessions.sessions.map((session) => <SessionCard key={session.id} session={session} />)
            ) : (
              <div className="notice">暂无会话</div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
