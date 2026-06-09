import { useCallback, useEffect, useRef, useState } from 'react';
import { userRequest } from '../api/client';
import type { UserDevice } from '../api/types';

const POLL_INTERVAL = 5_000;

export function useDevices(enabled: boolean) {
  const [devices, setDevices] = useState<UserDevice[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const initialLoad = useRef(true);

  const refresh = useCallback(async (isPoll = false) => {
    if (!enabled || inFlight.current) return;
    inFlight.current = true;
    if (!isPoll) setLoading(true);
    setError(null);
    try {
      setDevices(await userRequest<UserDevice[]>('/api/v1/user/devices'));
    } catch (err) {
      setDevices([]);
      setError(err instanceof Error ? err.message : 'Failed to load devices');
    } finally {
      setLoading(false);
      inFlight.current = false;
    }
  }, [enabled]);

  useEffect(() => {
    initialLoad.current = true;
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!enabled) {
      setDevices([]);
      return;
    }

    function startPoll() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => void refresh(true), POLL_INTERVAL);
    }
    function stopPoll() {
      if (!pollRef.current) return;
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    function onVisibility() {
      if (document.hidden) stopPoll();
      else { void refresh(true); startPoll(); }
    }
    function onFocus() {
      void refresh(true);
    }

    startPoll();
    window.addEventListener('focus', onFocus);
    window.addEventListener('pageshow', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPoll();
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('pageshow', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, refresh]);

  return { devices, loading, error, refresh };
}
