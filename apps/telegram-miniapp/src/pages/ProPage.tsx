import { useNavigate } from 'react-router-dom';
import { RedeemCode } from '../components/RedeemCode';
import type { AuthState } from '../hooks/useAuth';
import { useSubscription } from '../hooks/useSubscription';

interface Props {
  auth: AuthState;
}

const PRO_FEATURES = [
  {
    icon: '\u221E',
    title: 'Unlimited approvals',
    desc: 'Review and approve as many AI agent actions as you need, no monthly cap.',
  },
  {
    icon: '\u26A1',
    title: 'Priority delivery',
    desc: 'Approval requests reach your phone faster, even when relay traffic is high.',
  },
  {
    icon: '\u{1F512}',
    title: 'End-to-end encryption',
    desc: 'Commands and prompts stay encrypted between your desktop and phone.',
  },
  {
    icon: '\u{1F4F1}',
    title: 'Multi-device sync',
    desc: 'Pair multiple desktops and phones, switch seamlessly without losing context.',
  },
  {
    icon: '\u{1F4AC}',
    title: 'Priority support',
    desc: 'Direct line to the team for issues, feedback, and feature requests.',
  },
];

export function ProPage({ auth }: Props) {
  const navigate = useNavigate();
  const enabled = !!auth.token && !auth.loading;
  const subscription = useSubscription(enabled);
  const tier = subscription.subscription?.tier ?? 'free';
  const usage = subscription.subscription?.usage ?? null;

  return (
    <main className="shell pro-page">
      <header className="page-header">
        <button className="ghost-button" type="button" onClick={() => navigate(-1)}>
          Back
        </button>
        <span className={`pro-status-tag pro-status-${tier}`}>
          {tier === 'pro' ? 'Pro active' : tier === 'trial' ? 'Trial' : 'Free plan'}
        </span>
      </header>

      <section className="pro-hero">
        <p className="eyebrow">CodeKey Pro</p>
        <h1 className="pro-title">Approve without limits.</h1>
        <p className="pro-tagline">
          Stay in control of every AI agent action from your phone &mdash;
          no monthly approval cap, no interruptions when you need to ship.
        </p>

        <div className="pro-compare">
          <div className="pro-compare-col">
            <span className="pro-compare-label">Free</span>
            <span className="pro-compare-value">
              {usage ? `${usage.limit}` : '30'}
              <span className="pro-compare-unit">/ month</span>
            </span>
            <span className="pro-compare-foot">approvals</span>
          </div>
          <div className="pro-compare-divider">&rarr;</div>
          <div className="pro-compare-col pro-compare-col-pro">
            <span className="pro-compare-label">Pro</span>
            <span className="pro-compare-value pro-compare-value-pro">&infin;</span>
            <span className="pro-compare-foot">unlimited</span>
          </div>
        </div>
      </section>

      <section className="pro-features">
        <h2 className="pro-section-title">What you get with Pro</h2>
        <ul className="pro-feature-list">
          {PRO_FEATURES.map((f) => (
            <li className="pro-feature-item" key={f.title}>
              <span className="pro-feature-icon">{f.icon}</span>
              <div className="pro-feature-text">
                <span className="pro-feature-title">{f.title}</span>
                <span className="pro-feature-desc">{f.desc}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="pro-cta">
        <a
          className="primary-button link-button pro-cta-button"
          href="https://tinymoney.ccwu.cc"
          target="_blank"
          rel="noopener noreferrer"
        >
          Subscribe to Pro &rarr;
        </a>
        <p className="pro-cta-hint">Opens the subscription page in your browser.</p>
      </section>

      <section className="pro-redeem">
        <h2 className="pro-section-title">Have a redeem code?</h2>
        <RedeemCode onRedeemed={() => void subscription.refresh()} />
      </section>
    </main>
  );
}
