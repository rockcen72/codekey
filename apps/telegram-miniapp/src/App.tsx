import { useEffect, useRef } from 'react';
import { Navigate, Route, Routes, useNavigate, useSearchParams } from 'react-router-dom';
import { ThemeProvider } from './components/ThemeProvider';
import { useAuth } from './hooks/useAuth';
import { WsClient } from './services/ws-client';
import { BindPage } from './pages/BindPage';
import { LoginPage } from './pages/LoginPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';
import { getTelegramStartParam, parsePairingStartParam } from './auth/pairing-start-param';

const PROCESSED_KEY = 'ck:processed_start_param';

function DeepLinkRedirect({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const [params] = useSearchParams();
  const sessionId = params.get('sessionId');
  const eventId = params.get('eventId');

  if (auth.loading) return null;

  const startParam = getTelegramStartParam(params);
  // Use sessionStorage to track processed startParams — survives component
  // mount/unmount cycles and allows processing if Telegram navigates to a
  // new deep link within the same WebView (different startParam value).
  const alreadyProcessed = sessionStorage.getItem(PROCESSED_KEY) === startParam;

  const parsedStartParam = parsePairingStartParam(startParam);

  if (parsedStartParam?.contentKey && parsedStartParam.keyId && !alreadyProcessed) {
    sessionStorage.setItem(PROCESSED_KEY, startParam);
    const target = `/bind?code=${parsedStartParam.code}&key_id=${encodeURIComponent(parsedStartParam.keyId)}&content_key=${encodeURIComponent(parsedStartParam.contentKey)}`;
    if (!auth.token) {
      return <Navigate to={`/login?redirect=${encodeURIComponent(target)}`} replace />;
    }
    return <Navigate to={target} replace />;
  }

  if (parsedStartParam?.code && !alreadyProcessed) {
    sessionStorage.setItem(PROCESSED_KEY, startParam);
    const target = `/bind?code=${parsedStartParam.code}`;
    if (!auth.token) {
      return <Navigate to={`/login?redirect=${encodeURIComponent(target)}`} replace />;
    }
    return <Navigate to={target} replace />;
  }

  if (!auth.token) {
    const target = sessionId
      ? `/?sessionId=${sessionId}${eventId ? `&eventId=${eventId}` : ''}`
      : '/';
    return <Navigate to={`/login?redirect=${encodeURIComponent(target)}`} replace />;
  }
  if (sessionId) {
    const path = `/sessions/${sessionId}${eventId ? `?eventId=${eventId}` : ''}`;
    return <Navigate to={path} replace />;
  }
  return <SessionsPage auth={auth} />;
}

export default function App() {
  const auth = useAuth();
  const navigate = useNavigate();
  const wsRef = useRef<WsClient | null>(null);

  const relayUrl = import.meta.env.VITE_RELAY_URL || '';

  useEffect(() => {
    if (!auth.token || !auth.deviceId || !auth.clientToken || !relayUrl) {
      wsRef.current?.disconnect();
      wsRef.current = null;
      return;
    }

    const ws = new WsClient(relayUrl, auth.deviceId, auth.clientToken);
    ws.on('auth_failed', () => {
      auth.clearBinding();
      navigate('/bind', { replace: true });
    });
    ws.connect();
    wsRef.current = ws;

    return () => {
      ws.disconnect();
    };
  }, [auth.token, auth.deviceId, auth.clientToken, auth.clearBinding, navigate, relayUrl]);

  return (
    <ThemeProvider>
      <Routes>
        <Route path="/login" element={<LoginPage auth={auth} />} />
        <Route path="/bind" element={<BindPage auth={auth} />} />
        <Route path="/settings" element={auth.token ? <SettingsPage auth={auth} /> : <Navigate to="/login" replace />} />
        <Route path="/sessions/:id" element={auth.token ? <SessionDetailPage auth={auth} /> : <Navigate to="/login" replace />} />
        <Route path="/" element={<DeepLinkRedirect auth={auth} />} />
      </Routes>
    </ThemeProvider>
  );
}
