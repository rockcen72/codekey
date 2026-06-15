import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SessionCard } from '../components/SessionCard';
import { SubscriptionPill } from '../components/SubscriptionPill';
import { RedeemCode } from '../components/RedeemCode';
import { UnboundDeviceError, userRequest } from '../api/client';
import type { UserDevice } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { useDevices } from '../hooks/useDevices';
import { useSessions } from '../hooks/useSessions';
import { useSubscription } from '../hooks/useSubscription';
import { collectAgentTabs } from '../utils/session-display';

interface Props {
  auth: AuthState;
}

export function SessionsPage({ auth }: Props) {
  const [activeTab, setActiveTab] = useState('all');
  const [unbindTarget, setUnbindTarget] = useState<UserDevice | null>(null);
  const [unbindBusy, setUnbindBusy] = useState(false);
  const [unbindError, setUnbindError] = useState<string | null>(null);
  const enabled = !!auth.token && !auth.loading;
  const devices = useDevices(enabled);
  const sessions = useSessions(enabled);
  const subscription = useSubscription(enabled);
  const agentTabs = useMemo(() => collectAgentTabs(sessions.sessions), [sessions.sessions]);
  const selectedTab = agentTabs.some((tab) => tab.key === activeTab) ? activeTab : 'all';
  const visibleSessions = useMemo(() => {
    return selectedTab === 'all'
      ? sessions.sessions
      : sessions.sessions.filter((session) => (session.agent_type || session.metadata.runtime || 'unknown') === selectedTab);
  }, [selectedTab, sessions.sessions]);
  const activeTotal = sessions.sessions.filter((session) => session.status === 'active').length;
  const serviceOnline = enabled && !devices.error && !sessions.error;

  async function confirmUnbind() {
    if (!unbindTarget) return;
    setUnbindBusy(true);
    setUnbindError(null);
    try {
      await userRequest(`/api/v1/user/devices/${unbindTarget.id}`, { method: 'DELETE' });
      setUnbindTarget(null);
      auth.clearBinding();
      await Promise.all([devices.refresh(), sessions.refresh()]);
    } catch (err) {
      // The device is already unbound on the server (another platform
      // took over, or the desktop unpaired) — clear local state and
      // close the dialog without surfacing a noisy error.
      if (err instanceof UnboundDeviceError) {
        setUnbindTarget(null);
        auth.clearBinding();
      } else {
        setUnbindError(err instanceof Error ? err.message : 'Unbind failed');
      }
    } finally {
      setUnbindBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="sessions-topbar">
        <div className="topbar-left">
          <h1 className="brand">History</h1>
          <p className="brand-sub">CodeKey AI Remote</p>
        </div>
        <div className="top-actions">
          {devices.devices.length > 0 && subscription.subscription ? <SubscriptionPill subscription={subscription.subscription} /> : null}
          <div className={`conn-pill ${serviceOnline ? 'online' : 'offline'}`}>
            <span className="conn-dot" />
            <span>{serviceOnline ? 'Online' : 'Offline'}</span>
          </div>
          <Link className="icon-btn-wrap" to="/settings" aria-label="Device settings">⚙</Link>
        </div>
      </header>

      {activeTotal > 0 ? (
        <div className="metrics-row">
          <span className="metric-chip">
            <span className="metric-dot active" />
            <span>{activeTotal} active</span>
          </span>
        </div>
      ) : null}

      <div className="tabs-scroll">
        <div className="tabs">
          {agentTabs.map((tab) => (
            <button
              key={tab.key}
              className={`tab ${selectedTab === tab.key ? 'active' : ''}`}
              type="button"
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div className="sessions-actions-row">
        <span>{devices.devices.length} device(s) connected</span>
        <div className="history-actions">
          {devices.devices.length > 0 ? (
            <button
              className="ghost-link danger-button"
              type="button"
              onClick={() => {
                setUnbindError(null);
                setUnbindTarget(devices.devices[0]);
              }}
            >
              Unbind device
            </button>
          ) : null}
          <button
            className="ghost-link"
            type="button"
            onClick={() => {
              void devices.refresh();
              void sessions.refresh();
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {devices.error || sessions.error || unbindError ? <div className="notice error-text">{devices.error || sessions.error || unbindError}</div> : null}

      {subscription.subscription && subscription.subscription.tier === 'free' ? (
        <section className="subscription-summary compact-redeem">
          <RedeemCode onRedeemed={() => void subscription.refresh()} />
        </section>
      ) : null}

      {devices.devices.length === 0 ? (
        <section className="empty-state">
          <h2>No devices connected</h2>
          <p>Generate a pairing code in the desktop extension to connect.</p>
          <Link className="primary-button link-button" to="/bind">Connect device</Link>
        </section>
      ) : (
        <>
          <section className="session-list">
            {visibleSessions.length > 0 ? (
              visibleSessions.map((session) => <SessionCard key={session.id} session={session} />)
            ) : (
              <div className="empty">
                <span className="empty-icon">◌</span>
                <h2 className="empty-title">No conversations yet</h2>
                <p className="empty-text">Sessions will appear here once you start an AI agent on your desktop.</p>
              </div>
            )}
          </section>
        </>
      )}

      {unbindTarget ? (
        <div className="modal-backdrop" onClick={() => setUnbindTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Unbind device</h2>
            <p>
              This device's History will no longer appear here. Re-pair by generating a new code in the desktop extension.
              <br />
              Device: <strong>{unbindTarget.device_name || 'Unnamed Device'}</strong>
              <br />
              ID: <code>{unbindTarget.id.slice(-6)}</code>
            </p>
            {unbindError ? <p className="error-text">{unbindError}</p> : null}
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setUnbindTarget(null)} disabled={unbindBusy}>
                Cancel
              </button>
              <button className="primary-button danger-confirm" type="button" onClick={() => void confirmUnbind()} disabled={unbindBusy}>
                {unbindBusy ? 'Unbinding...' : 'Unbind'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
