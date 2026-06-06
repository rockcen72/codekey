import { Navigate } from 'react-router-dom';
import type { AuthState } from '../hooks/useAuth';

interface Props {
  auth: AuthState;
}

export function LoginPage({ auth }: Props) {
  if (auth.token) return <Navigate to="/" replace />;

  const hasTelegram = !!window.Telegram?.WebApp;
  const initDataLength = window.Telegram?.WebApp.initData?.length ?? 0;
  const title = auth.loading ? '正在连接你的 CodeKey' : auth.error ? '连接失败' : '等待连接';

  return (
    <main className="shell centered">
      <section className="login-panel">
        <p className="eyebrow">CodeKey Telegram Gateway</p>
        <h1>{title}</h1>
        <p className="muted">{auth.error || '请稍候，正在校验 Telegram 身份。'}</p>
        <dl className="debug-list">
          <div>
            <dt>Telegram WebApp</dt>
            <dd>{hasTelegram ? 'detected' : 'missing'}</dd>
          </div>
          <div>
            <dt>Init data</dt>
            <dd>{initDataLength > 0 ? `${initDataLength} chars` : '-'}</dd>
          </div>
        </dl>
        <button className="primary-button" type="button" onClick={() => void auth.login()} disabled={auth.loading}>
          {auth.loading ? '连接中' : '重新连接'}
        </button>
      </section>
    </main>
  );
}
