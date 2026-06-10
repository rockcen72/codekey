import { useState } from 'react';
import { userRequest } from '../api/client';
import type { RedeemResult } from '../api/types';

interface Props {
  onRedeemed: () => void;
}

const REDEEM_ERRORS: Record<string, string> = {
  invalid_format: 'Invalid code format',
  not_found: 'Code not found',
  product_mismatch: 'Code does not apply to current product',
  already_used: 'Code already used',
  void: 'Code expired',
};

export function RedeemCode({ onRedeemed }: Props) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleRedeem() {
    if (!code.trim()) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    try {
      const result = await userRequest<RedeemResult>('/api/v1/redeem', {
        method: 'POST',
        body: JSON.stringify({ code: code.trim() }),
      });
      setSuccess(`Activated ${result.plan}, valid for ${result.durationDays} days`);
      setCode('');
      onRedeemed();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Redeem failed';
      // Try to extract server error code
      const known = Object.keys(REDEEM_ERRORS).find(k => msg.toLowerCase().includes(k));
      setError(known ? REDEEM_ERRORS[known] : msg);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="redeem-section">
      <div className="redeem-row">
        <input
          className="redeem-input"
          type="text"
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="CK-XXXX-XXXX-XXXX"
          maxLength={19}
          disabled={busy}
        />
        <button
          className="primary-button btn-sm"
          type="button"
          disabled={!code.trim() || busy}
          onClick={() => void handleRedeem()}
        >
          {busy ? '...' : 'Redeem'}
        </button>
      </div>
      {error ? <p className="error-text redeem-msg">{error}</p> : null}
      {success ? <p className="success-text redeem-msg">{success}</p> : null}
    </section>
  );
}
