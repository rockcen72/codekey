import { useCallback, useEffect, useState } from 'react';
import { userRequest } from '../api/client';
import type { SubscriptionStatus } from '../api/types';

export function useSubscription(enabled: boolean) {
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      setSubscription(await userRequest<SubscriptionStatus>('/api/v1/subscription'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load subscription');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { subscription, loading, error, refresh };
}
