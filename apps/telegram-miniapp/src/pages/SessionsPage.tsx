import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { SessionCard } from '../components/SessionCard';
import { SubscriptionPill } from '../components/SubscriptionPill';
import { RedeemCode } from '../components/RedeemCode';
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

  return (
    <main className="shell">
      <header className="sessions-topbar">
        <div className="topbar-left">
          <h1 className="brand">History</h1>
          <p className="brand-sub">CodeKey AI 远程控制</p>
        </div>
        <div className="top-actions">
          {subscription.subscription ? <SubscriptionPill subscription={subscription.subscription} /> : null}
          <div className={`conn-pill ${serviceOnline ? 'online' : 'offline'}`}>
            <span className="conn-dot" />
            <span>{serviceOnline ? '已同步' : '离线'}</span>
          </div>
          <Link className="icon-btn-wrap" to="/settings" aria-label="设备管理">⚙</Link>
        </div>
      </header>

      {activeTotal > 0 ? (
        <div className="metrics-row">
          <span className="metric-chip">
            <span className="metric-dot active" />
            <span>{activeTotal} 活跃</span>
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
        <span>{devices.devices.length} 台已绑定设备</span>
        <button className="ghost-link" type="button" onClick={() => void sessions.refresh()}>刷新</button>
      </div>

      {devices.error || sessions.error ? <div className="notice error-text">{devices.error || sessions.error}</div> : null}

      {subscription.subscription ? (
        <section className="subscription-summary compact-redeem">
          <RedeemCode onRedeemed={() => void subscription.refresh()} />
        </section>
      ) : null}

      {!devices.loading && devices.devices.length === 0 ? (
        <section className="empty-state">
          <h2>暂无绑定设备</h2>
          <p>在桌面端生成配对码后，在这里完成绑定。</p>
          <Link className="primary-button link-button" to="/bind">绑定设备</Link>
        </section>
      ) : (
        <>
          <section className="session-list">
            {visibleSessions.length > 0 ? (
              visibleSessions.map((session) => <SessionCard key={session.id} session={session} />)
            ) : (
              <div className="empty">
                <span className="empty-icon">◌</span>
                <h2 className="empty-title">暂无对话记录</h2>
                <p className="empty-text">在桌面端启动 AI 代理后，关联的会话将出现在这里。</p>
              </div>
            )}
          </section>
        </>
      )}
    </main>
  );
}
