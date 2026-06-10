import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { publicRequest, userRequest } from '../api/client';
import type { AuthState } from '../hooks/useAuth';
import type { ClaimResult, ConfirmResult } from '../api/types';

interface Props {
  auth: AuthState;
}

export function BindPage({ auth }: Props) {
  const navigate = useNavigate();
  const location = useLocation();

  // Read code from URL ?code= (passed by DeepLinkRedirect from start_param)
  const urlParams = new URLSearchParams(location.search);
  const urlCode = urlParams.get('code') || '';

  const [code, setCode] = useState(urlCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function bindWithCode(code: string) {
    if (!auth.token || code.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      const confirm = await publicRequest<ConfirmResult>('/api/v1/devices/confirm', {
        method: 'POST',
        body: JSON.stringify({ code, platform: 'telegram' }),
      });
      await userRequest<ClaimResult>('/api/v1/auth/claim-device', {
        method: 'POST',
        body: JSON.stringify({ clientToken: confirm.clientToken }),
      });
      navigate('/', { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Binding failed');
    } finally {
      setBusy(false);
    }
  }

  // Auto-submit when URL has code and auth is ready
  useEffect(() => {
    if (!auth.token) return;
    if (code && code.length >= 8) {
      const timer = setTimeout(() => { void bindWithCode(code); }, 600);
      return () => clearTimeout(timer);
    }
  }, [auth.token]);

  return (
    <main className="shell">
      <header className="page-header">
        <button className="ghost-button" type="button" onClick={() => navigate('/')}>Back</button>
        <h1>Bind Device</h1>
      </header>
      <section className="tool-panel">
        <label className="field-label" htmlFor="pair-code">Pairing Code</label>
        <input
          id="pair-code"
          className="code-input"
          inputMode="text"
          maxLength={8}
          value={code}
          onChange={(event) => setCode(event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
          placeholder="ABCDEFGH"
        />
        {error ? <p className="error-text">{error}</p> : null}
        <button className="primary-button" type="button" onClick={() => void bindWithCode(code)} disabled={busy || code.length < 8}>
          {busy ? 'Binding...' : 'Confirm'}
        </button>
      </section>
    </main>
  );
}
