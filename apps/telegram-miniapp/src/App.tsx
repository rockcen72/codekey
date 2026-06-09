import { Navigate, Route, Routes, useSearchParams } from 'react-router-dom';
import { ThemeProvider } from './components/ThemeProvider';
import { useAuth } from './hooks/useAuth';
import { BindPage } from './pages/BindPage';
import { LoginPage } from './pages/LoginPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';

function DeepLinkRedirect() {
  const auth = useAuth();
  const [params] = useSearchParams();
  const sessionId = params.get('sessionId');

  if (auth.loading) return null;
  if (!auth.token) {
    const target = sessionId ? `/?sessionId=${sessionId}` : '/';
    return <Navigate to={`/login?redirect=${encodeURIComponent(target)}`} replace />;
  }
  if (sessionId) return <Navigate to={`/sessions/${sessionId}`} replace />;
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
        <Route path="/" element={<DeepLinkRedirect />} />
      </Routes>
    </ThemeProvider>
  );
}
