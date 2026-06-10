import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { ThemeProvider } from './components/ThemeProvider';
import { useAuth } from './hooks/useAuth';
import { BindPage } from './pages/BindPage';
import { LoginPage } from './pages/LoginPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';

// Module-level flag — persists across component mounts for the lifetime of the Mini App.
// Prevents start_param from being processed more than once (avoids redirect loop).
let processedStartParam = false;

function DeepLinkRedirect({ auth }: { auth: ReturnType<typeof useAuth> }) {
  const [params] = useSearchParams();
  const sessionId = params.get('sessionId');
  const eventId = params.get('eventId');

  // auth.loading must come first — don't jump during login recovery
  if (auth.loading) return null;

  // Detect start_param from Telegram deep link (QR code scan)
  // Only process ONCE to avoid redirect loop after bind completes
  const startParam = window.Telegram?.WebApp?.initDataUnsafe?.start_param || '';
  const hasCode = /^[A-Z0-9]{8}$/.test(startParam);
  if (hasCode && !processedStartParam) {
    processedStartParam = true;
    const target = `/bind?code=${startParam}`;
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
