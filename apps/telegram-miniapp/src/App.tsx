import { Navigate, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from './components/ThemeProvider';
import { useAuth } from './hooks/useAuth';
import { BindPage } from './pages/BindPage';
import { LoginPage } from './pages/LoginPage';
import { SessionDetailPage } from './pages/SessionDetailPage';
import { SessionsPage } from './pages/SessionsPage';
import { SettingsPage } from './pages/SettingsPage';

export default function App() {
  const auth = useAuth();

  return (
    <ThemeProvider>
      <Routes>
        <Route path="/login" element={<LoginPage auth={auth} />} />
        <Route path="/bind" element={<BindPage auth={auth} />} />
        <Route path="/settings" element={auth.token ? <SettingsPage auth={auth} /> : <Navigate to="/login" replace />} />
        <Route path="/sessions/:id" element={auth.token ? <SessionDetailPage auth={auth} /> : <Navigate to="/login" replace />} />
        <Route path="/" element={auth.token ? <SessionsPage auth={auth} /> : <Navigate to="/login" replace />} />
      </Routes>
    </ThemeProvider>
  );
}
