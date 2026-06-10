import { Navigate, useSearchParams } from 'react-router-dom';
import type { AuthState } from '../hooks/useAuth';

interface Props {
  auth: AuthState;
}

export function LoginPage({ auth }: Props) {
  const [params] = useSearchParams();
  const rawRedirect = params.get('redirect') || '/';
  // Only allow site-internal redirects (starts with /)
  const redirectTo = rawRedirect.startsWith('/') ? rawRedirect : '/';

  if (auth.token) return <Navigate to={redirectTo} replace />;

  const missingTelegramInitData = auth.error?.includes('Telegram initData not detected');
  const title = auth.loading
    ? 'Connecting to CodeKey'
    : missingTelegramInitData
      ? 'Open from Telegram'
      : auth.error
        ? 'Connection failed'
        : 'Waiting for login';
  const message = missingTelegramInitData
    ? 'No Telegram Mini App initData found. Please open this page from the CodeKey button in Telegram Bot. Local browser preview cannot complete login.'
    : auth.error || 'Verifying Telegram identity...';

  return (
    <main className="shell centered">
      <section className="login-panel">
        <p className="eyebrow">CodeKey Telegram Gateway</p>
        <h1>{title}</h1>
        <p className="muted">{message}</p>
        <button className="primary-button" type="button" onClick={() => void auth.login()} disabled={auth.loading}>
          {auth.loading ? 'Connecting...' : 'Retry'}
        </button>
      </section>
    </main>
  );
}
