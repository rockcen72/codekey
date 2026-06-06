interface Props {
  tier?: string;
}

export function SubscriptionPill({ tier }: Props) {
  if (!tier) return null;
  return <span className={`subscription-pill tier-${tier}`}>{tier.toUpperCase()}</span>;
}
