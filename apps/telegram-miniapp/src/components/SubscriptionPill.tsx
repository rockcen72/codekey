import type { SubscriptionStatus } from '../api/types';

interface Props {
  subscription: SubscriptionStatus;
}

const TIER_LABEL: Record<string, string> = {
  free: 'Free',
  trial: 'Trial',
  pro: 'Pro',
};

function daysRemaining(expiresAt: string | null): number | null {
  if (!expiresAt) return null;
  return Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 86_400_000);
}

export function SubscriptionPill({ subscription }: Props) {
  const { tier, usage, expiresAt } = subscription;
  const days = daysRemaining(expiresAt);
  const quotaState = tier === 'free' && usage
    ? usage.used >= usage.limit
      ? 'exhausted'
      : usage.used >= Math.floor(usage.limit * 0.8)
        ? 'approaching'
        : 'normal'
    : 'hidden';
  const isExpiringSoon = tier !== 'free' && days !== null && days >= 0 && days <= 3;
  const label = tier === 'free' && usage
    ? quotaState === 'exhausted'
      ? 'Free \u00b7 Used up'
      : `Free \u00b7 ${usage.used}/${usage.limit}`
    : tier === 'trial' && days !== null && days >= 0
      ? `Trial \u00b7 ${days}d`
      : TIER_LABEL[tier] || tier.toUpperCase();
  const className = isExpiringSoon ? 'sub-pill-expiring' : `sub-pill-${quotaState === 'hidden' ? `tier-${tier}` : quotaState}`;

  return (
    <a href="https://tinymoney.ccwu.cc" target="_blank" rel="noopener noreferrer" className={`sub-pill sub-pill-link ${className}`} aria-label="Manage subscription">
      {label}
    </a>
  );
}
