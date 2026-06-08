import type { SubscriptionStatus } from '../api/types';

interface Props {
  subscription: SubscriptionStatus;
}

const TIER_LABEL: Record<string, string> = {
  free: '免费版',
  trial: '试用版',
  pro: '专业版',
};

export function SubscriptionPill({ subscription }: Props) {
  const { tier, usage } = subscription;
  return (
    <span className="subscription-bar">
      <span className={`subscription-pill tier-${tier}`}>{TIER_LABEL[tier] || tier.toUpperCase()}</span>
      {tier === 'free' && usage ? (
        <span className="usage-text">本月已用 {usage.used}/{usage.limit}</span>
      ) : null}
    </span>
  );
}
