import { useCallback, useEffect, useState } from 'react';
import { userRequest } from '../api/client';
import type { UserDevice } from '../api/types';

export function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<UserDevice[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      setDevices(await userRequest<UserDevice[]>('/api/v1/user/devices'));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { devices, loading, error, refresh };
}
