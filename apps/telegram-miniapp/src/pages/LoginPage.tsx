import { Navigate } from 'react-router-dom';
import type { AuthState } from '../hooks/useAuth';

interface Props {
  auth: AuthState;
}

export function LoginPage({ auth }: Props) {
  if (auth.token) return <Navigate to="/" replace />;

  const title = auth.loading ? 'Connecting to CodeKey' : auth.error ? 'Connection Failed' : 'Waiting';

  return (
    <main className="shell centered">
      <section className="login-panel">
        <p className="eyebrow">CodeKey Telegram Gateway</p>
        <h1>{title}</h1>
        <p className="muted">{auth.error || 'Verifying your Telegram identity...'}</p>
        <button className="primary-button" type="button" onClick={() => void auth.login()} disabled={auth.loading}>
          {auth.loading ? 'Connecting...' : 'Retry'}
        </button>
      </section>
    </main>
  );
}
