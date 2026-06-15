import { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { publicRequest, userRequest } from '../api/client';
import type { AuthState } from '../hooks/useAuth';
import type { ClaimResult, ConfirmResult } from '../api/types';
import { setDeviceCredentials, setContentKey, clearContentKey } from '../auth/device-storage';
import { getTelegramStartParam, parsePairingStartParam } from '../auth/pairing-start-param';
import { generateEcdhKeyPair, deriveKeyMaterial } from '../utils/encryption';

interface Props {
  auth: AuthState;
}

export function BindPage({ auth }: Props) {
  const navigate = useNavigate();
  const location = useLocation();

  // Read code + key params from URL (keys come from auto-parsed startapp payload)
  const urlParams = new URLSearchParams(location.search);
  const parsedStartParam = parsePairingStartParam(getTelegramStartParam(urlParams));
  const urlCode = urlParams.get('code') || parsedStartParam?.code || '';
  const urlKeyId = urlParams.get('key_id') || parsedStartParam?.keyId || '';
  const urlContentKey = urlParams.get('content_key') || parsedStartParam?.contentKey || '';
  const hasE2EKey = !!(urlContentKey && urlKeyId);

  const [code, setCode] = useState(urlCode);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bound, setBound] = useState(false);
  const [confirmEcdh, setConfirmEcdh] = useState(false);

  async function bindWithCode(code: string) {
    if (!auth.token || code.length < 8) return;
    setBusy(true);
    setError(null);
    try {
      // Generate ECDH keypair for E2E key exchange
      const ecdhKeyPair = await generateEcdhKeyPair();

      const confirm = await publicRequest<ConfirmResult>('/api/v1/devices/confirm', {
        method: 'POST',
        body: JSON.stringify({ code, platform: 'telegram', phonePublicKeyHex: ecdhKeyPair.publicKeyHex, e2eKeyReceived: hasE2EKey }),
      });

      // Phase 2: derive E2E key material BEFORE claim-device, persist AFTER.
      // If derivation fails, the binding is aborted cleanly.
      let ecdhDerived = false;
      let contentKey: string | undefined;
      let keyId: string | undefined;
      if (confirm.e2eAvailable && confirm.desktopPublicKeyHex) {
        const material = await deriveKeyMaterial(ecdhKeyPair.privateKey, confirm.desktopPublicKeyHex);
        contentKey = material.contentKeyHex;
        keyId = material.keyId;
        ecdhDerived = true;
      } else if (confirm.e2eAvailable) {
        throw new Error('Server reports E2E available but no desktop key was returned');
      }

      // Phase 1 fallback: QR-embedded key
      if (!ecdhDerived && hasE2EKey) {
        contentKey = urlContentKey;
        keyId = urlKeyId;
      }

      // Claim device + persist everything atomically (E2E key + credentials)
      await userRequest<ClaimResult>('/api/v1/auth/claim-device', {
        method: 'POST',
        body: JSON.stringify({ clientToken: confirm.clientToken }),
      });
      setDeviceCredentials(confirm.deviceId, confirm.clientToken);
      if (contentKey && keyId) {
        setContentKey(contentKey, keyId);
      } else {
        clearContentKey();
      }

      setConfirmEcdh(ecdhDerived);
      auth.refreshBinding();
      setBound(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Binding failed');
    } finally {
      setBusy(false);
    }
  }

  // Auto-submit when URL carries code. Keys may or may not be present.
  const hasCode = code && code.length >= 8;
  useEffect(() => {
    if (!auth.token) return;
    if (hasCode) {
      const timer = setTimeout(() => { void bindWithCode(code); }, 600);
      return () => clearTimeout(timer);
    }
  }, [auth.token]);

  // Navigate to home after success
  useEffect(() => {
    if (bound) {
      const timer = setTimeout(() => navigate('/', { replace: true }), 800);
      return () => clearTimeout(timer);
    }
  }, [bound]);

  return (
    <main className="shell">
      <header className="page-header">
        <button className="ghost-button" type="button" onClick={() => navigate('/')}>Back</button>
        <h1>Bind Device</h1>
      </header>
      {bound ? (
        <section className="tool-panel">
          <p className="success-text">Device bound successfully!</p>
          {confirmEcdh ? (
            <p className="success-text" style={{marginTop:8,fontSize:13}}>E2E encryption established via ECDH key exchange.</p>
          ) : hasE2EKey ? (
            <p className="success-text" style={{marginTop:8,fontSize:13}}>E2E encryption key received &amp; saved.</p>
          ) : (
            <p className="muted" style={{marginTop:8,fontSize:13}}>Manual code binding does not enable E2E encryption. Scan the QR code from VS Code to enable it.</p>
          )}
        </section>
      ) : (
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
          <section className="howto-panel">
            <h2>How to use CodeKey</h2>
            <ol>
              <li>Install the <strong>CodeKey</strong> extension from the VS Code marketplace.</li>
              <li>Open the extension sidebar and tap <strong>&ldquo;Start Pairing&rdquo;</strong> to generate a code.</li>
              <li>Scan the QR code with your phone to auto-fill the code and E2E key.</li>
              <li>Start any AI agent on your desktop (Claude Code, Codex, or OpenCode).</li>
              <li>Your sessions will appear here in real time — tap any session to view details, approve actions, or reply.</li>
            </ol>
          </section>
        </section>
      )}
    </main>
  );
}
