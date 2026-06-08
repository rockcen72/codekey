import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { userRequest } from '../api/client';
import type { UserDevice } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { useDevices } from '../hooks/useDevices';
import { DeviceBadge } from '../components/DeviceBadge';
import { formatDate } from '../utils/format';

interface Props {
  auth: AuthState;
}

export function SettingsPage({ auth }: Props) {
  const enabled = !!auth.token && !auth.loading;
  const devices = useDevices(enabled);
  const navigate = useNavigate();
  const [unbindTarget, setUnbindTarget] = useState<UserDevice | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirmUnbind() {
    if (!unbindTarget) return;
    setBusy(true);
    setError(null);
    try {
      await userRequest(`/api/v1/user/devices/${unbindTarget.id}`, { method: 'DELETE' });
      setUnbindTarget(null);
      await devices.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unbind failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="page-header">
        <button className="ghost-button" type="button" onClick={() => navigate('/')}>Back</button>
        <h1>Device Management</h1>
      </header>

      {devices.loading ? <div className="notice">Loading...</div> : null}
      {devices.error ? <div className="notice error-text">{devices.error}</div> : null}
      {error ? <div className="notice error-text">{error}</div> : null}

      {devices.devices.length === 0 && !devices.loading ? (
        <div className="empty-state">
          <h2>No devices bound</h2>
          <p>Generate a pairing code on your desktop, then enter it here.</p>
        </div>
      ) : (
        <section className="device-manage-list">
          {devices.devices.map((d) => (
            <div className="device-manage-item" key={d.id}>
              <div className="device-manage-info">
                <DeviceBadge name={d.device_name} deviceId={d.id} />
                <span className="muted">Bound {formatDate(d.bound_at)}</span>
              </div>
              <button
                className="ghost-button danger-button"
                type="button"
                onClick={() => setUnbindTarget(d)}
              >
                Unbind
              </button>
            </div>
          ))}
        </section>
      )}

      {unbindTarget ? (
        <div className="modal-backdrop" onClick={() => setUnbindTarget(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h2>Confirm Unbind</h2>
            <p>
              All sessions from this device will be removed from your phone.
              <br />
              Device: <strong>{unbindTarget.device_name || 'Unnamed Device'}</strong>
              <br />
              ID: <code>{unbindTarget.id.slice(-6)}</code>
            </p>
            {error ? <p className="error-text">{error}</p> : null}
            <div className="modal-actions">
              <button className="ghost-button" type="button" onClick={() => setUnbindTarget(null)} disabled={busy}>
                Cancel
              </button>
              <button className="primary-button danger-confirm" type="button" onClick={() => void confirmUnbind()} disabled={busy}>
                {busy ? 'Unbinding...' : 'Unbind'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
