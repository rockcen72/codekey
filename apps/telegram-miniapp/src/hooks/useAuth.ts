import { useCallback, useEffect, useState } from 'react';
import { AUTH_EXPIRED_EVENT, CLIENT_TOKEN_INVALID_EVENT, UnboundDeviceError, userRequest } from '../api/client';
import type { UserDevice } from '../api/types';
import { clearUserToken, getUserToken, setUserToken } from '../auth/storage';
import { getDeviceId, getClientToken, clearDeviceCredentials } from '../auth/device-storage';
import { loginWithTelegram } from '../auth/telegram-login';

export interface AuthState {
  token: string | null;
  deviceId: string | null;
  clientToken: string | null;
  loading: boolean;
  error: string | null;
  login: () => Promise<void>;
  logout: () => void;
  refreshBinding: () => void;
  clearBinding: () => void;
}

export function useAuth(): AuthState {
  const [token, setToken] = useState<string | null>(() => getUserToken());
  const [deviceId, setDeviceId] = useState<string | null>(() => getDeviceId());
  const [clientToken, setClientToken] = useState<string | null>(() => getClientToken());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const login = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await loginWithTelegram();
      setUserToken(result.token);
      setToken(result.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
      clearUserToken();
      setToken(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const logout = useCallback(() => {
    clearUserToken();
    clearDeviceCredentials();
    setToken(null);
    setDeviceId(null);
    setClientToken(null);
  }, []);

  const refreshBinding = useCallback(() => {
    setDeviceId(getDeviceId());
    setClientToken(getClientToken());
  }, []);

  const clearBinding = useCallback(() => {
    clearDeviceCredentials();
    setDeviceId(null);
    setClientToken(null);
  }, []);

  useEffect(() => {
    function handleAuthExpired() {
      clearUserToken();
      clearDeviceCredentials();
      setToken(null);
      setDeviceId(null);
      setClientToken(null);
      setLoading(false);
    }
    function handleClientTokenInvalid() {
      // Server told us our clientToken is no longer the active one (the
      // other platform took over the device, or the device was unbound).
      // Keep the user_token so we don't bounce to login — just clear the
      // device credentials so the UI renders an unbound state.
      setDeviceId(null);
      setClientToken(null);
      setLoading(false);
    }
    window.addEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
    window.addEventListener(CLIENT_TOKEN_INVALID_EVENT, handleClientTokenInvalid);
    return () => {
      window.removeEventListener(AUTH_EXPIRED_EVENT, handleAuthExpired);
      window.removeEventListener(CLIENT_TOKEN_INVALID_EVENT, handleClientTokenInvalid);
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function boot() {
      if (!token) {
        await login();
        return;
      }
      try {
        await userRequest<UserDevice[]>('/api/v1/user/devices');
      } catch (err) {
        // Unbound device is an expected state (Telegram session has no
        // active clientToken, or another platform took over). user_token
        // remains valid — render the unbound state instead of looping
        // back into login().
        if (err instanceof UnboundDeviceError) {
          if (active) setLoading(false);
          return;
        }
        if (active) await login();
        return;
      }
      if (active) setLoading(false);
    }
    void boot();
    return () => {
      active = false;
    };
  }, [login, token]);

  return {
    token,
    deviceId,
    clientToken,
    loading,
    error,
    login,
    logout,
    refreshBinding,
    clearBinding,
  };
}
