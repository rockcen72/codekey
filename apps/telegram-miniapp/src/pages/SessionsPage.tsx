import { Link } from 'react-router-dom';
import { SessionCard } from '../components/SessionCard';
import { SubscriptionPill } from '../components/SubscriptionPill';
import { RedeemCode } from '../components/RedeemCode';
import type { AuthState } from '../hooks/useAuth';
import { useDevices } from '../hooks/useDevices';
import { useSessions } from '../hooks/useSessions';
import { useSubscription } from '../hooks/useSubscription';

interface Props {
  auth: AuthState;
}

export function SessionsPage({ auth }: Props) {
  const enabled = !!auth.token && !auth.loading;
  const devices = useDevices(enabled);
  const sessions = useSessions(enabled);
  const subscription = useSubscription(enabled);

  return (
    <main className="shell">
      <header className="page-header">
        <div>
          <p className="eyebrow">CodeKey Telegram Gateway</p>
          <h1>Sessions</h1>
        </div>
        <button className="ghost-button" type="button" onClick={() => void sessions.refresh()}>Refresh</button>
      </header>

      {devices.error || sessions.error ? <div className="notice error-text">{devices.error || sessions.error}</div> : null}

      {subscription.subscription ? (
        <section className="subscription-summary">
          <SubscriptionPill subscription={subscription.subscription} />
          <RedeemCode onRedeemed={() => void subscription.refresh()} />
        </section>
      ) : null}

      {!devices.loading && devices.devices.length === 0 ? (
        <section className="empty-state">
          <h2>No devices bound</h2>
          <p>Generate a pairing code on your desktop, then enter it here.</p>
          <Link className="primary-button link-button" to="/bind">Bind Device</Link>
        </section>
      ) : (
        <>
          <div className="summary-header">
            <h2>{devices.devices.length} bound device{devices.devices.length !== 1 ? 's' : ''}</h2>
            <span className="summary-actions">
              <Link to="/bind">Add</Link>
              <Link to="/settings">Manage</Link>
            </span>
          </div>
          <section className="session-list">
            {sessions.sessions.length > 0 ? (
              sessions.sessions.map((session) => <SessionCard key={session.id} session={session} />)
            ) : (
              <div className="notice">No sessions</div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
