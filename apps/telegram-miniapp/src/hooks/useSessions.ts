import { useCallback, useEffect, useRef, useState } from 'react';
import { userRequest } from '../api/client';
import type { UserSession } from '../api/types';

const POLL_INTERVAL = 5_000;

export function useSessions(enabled: boolean) {
  const [sessions, setSessions] = useState<UserSession[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    try {
      setSessions(await userRequest<UserSession[]>('/api/v1/user/sessions?history=1'));
    } catch (err) {
      setError(err instanceof Error ? err.message : '会话加载失败');
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 5s polling + visibilitychange pause/resume
  useEffect(() => {
    if (!enabled) return;

    function startPoll() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => void refresh(), POLL_INTERVAL);
    }
    function stopPoll() {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    function onVisibility() {
      if (document.hidden) stopPoll();
      else { void refresh(); startPoll(); }
    }

    startPoll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, refresh]);

  return { sessions, loading, error, refresh };
}
