import type { SubscriptionStatus } from '../api/types';

interface Props {
  subscription: SubscriptionStatus;
}

const TIER_LABEL: Record<string, string> = {
  free: 'Free',
  trial: 'Trial',
  pro: 'Pro',
};

function formatExpiry(expiresAt: string | null): string | null {
  if (!expiresAt) return null;
  const d = new Date(expiresAt);
  const now = new Date();
  const diffMs = d.getTime() - now.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));
  if (diffDays <= 0) return 'Expired';
  if (diffDays === 1) return 'Expires today';
  if (diffDays <= 3) return `${diffDays} days left`;
  return `Until ${d.toLocaleDateString()}`;
}

export function SubscriptionPill({ subscription }: Props) {
  const { tier, usage, expiresAt } = subscription;
  const expiryText = tier !== 'free' ? formatExpiry(expiresAt) : null;
  const isExpiringSoon = tier !== 'free' && expiresAt && (() => {
    const d = new Date(expiresAt);
    const now = new Date();
    return Math.ceil((d.getTime() - now.getTime()) / (1000 * 60 * 60 * 24)) <= 3;
  })();

  const usagePct = tier === 'free' && usage ? Math.round((usage.used / usage.limit) * 100) : 0;
  const usageClass = usagePct >= 100 ? 'exhausted' : usagePct >= 80 ? 'approaching' : 'normal';

  return (
    <div className="subscription-info">
      <span className="subscription-bar">
        <span className={`subscription-pill tier-${tier}`}>{TIER_LABEL[tier] || tier.toUpperCase()}</span>
        {expiryText ? <span className="expiry-text">{expiryText}</span> : null}
      </span>
      {tier === 'free' && usage ? (
        <div className="usage-bar-wrapper">
          <div className="usage-bar">
            <div className={`usage-bar-fill usage-bar-${usageClass}`} style={{ width: `${Math.min(usagePct, 100)}%` }} />
          </div>
          <span className={`usage-text usage-text-${usageClass}`}>
            {usage.used}/{usage.limit} this month
          </span>
        </div>
      ) : null}
      {isExpiringSoon ? (
        <div className="expiry-warning">Subscription expiring soon</div>
      ) : null}
    </div>
  );
}
