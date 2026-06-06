import { useCallback, useEffect, useState } from 'react';
import { userRequest } from '../api/client';
import type { UserSession } from '../api/types';

export function useSessions(enabled: boolean) {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) return;
    setLoading(true);
    setError(null);
    try {
      setSessions(await userRequest<UserSession[]>('/api/v1/user/sessions?history=1'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '会话加载失败');
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { sessions, loading, error, refresh };
}
