import { Navigate } from 'react-router-dom';
import type { AuthState } from '../hooks/useAuth';

interface Props {
  auth: AuthState;
}

export function LoginPage({ auth }: Props) {
  if (auth.token) return <Navigate to="/" replace />;

  const missingTelegramInitData = auth.error?.includes('Telegram initData not detected');
  const title = auth.loading
    ? '正在连接 CodeKey'
    : missingTelegramInitData
      ? '请从 Telegram 打开'
      : auth.error
        ? '连接失败'
        : '等待登录';
  const message = missingTelegramInitData
    ? '当前页面没有 Telegram Mini App 登录数据。请从 Telegram Bot 的 CodeKey 按钮打开；普通浏览器本地预览无法完成登录。'
    : auth.error || '正在校验 Telegram 身份...';

  return (
    <main className="shell centered">
      <section className="login-panel">
        <p className="eyebrow">CodeKey Telegram Gateway</p>
        <h1>{title}</h1>
        <p className="muted">{message}</p>
        <button className="primary-button" type="button" onClick={() => void auth.login()} disabled={auth.loading}>
          {auth.loading ? '连接中...' : '重试'}
        </button>
      </section>
    </main>
  );
}
