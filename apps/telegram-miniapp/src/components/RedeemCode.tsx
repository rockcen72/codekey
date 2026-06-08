import { useState } from 'react';
import { userRequest } from '../api/client';
import type { RedeemResult } from '../api/types';

interface Props {
  onRedeemed: () => void;
}

const REDEEM_ERRORS: Record<string, string> = {
  invalid_format: '兑换码格式不正确',
  not_found: '兑换码不存在',
  product_mismatch: '兑换码不适用于当前产品',
  already_used: '兑换码已被使用',
  void: '兑换码已失效',
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
      setSuccess(`已激活 ${result.plan}，有效期 ${result.durationDays} 天`);
      setCode('');
      onRedeemed();
    } catch (err) {
      const msg = err instanceof Error ? err.message : '兑换失败';
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
          {busy ? '...' : '兑换'}
        </button>
      </div>
      {error ? <p className="error-text redeem-msg">{error}</p> : null}
      {success ? <p className="success-text redeem-msg">{success}</p> : null}
    </section>
  );
}
