import { getDeviceId, clearAuth, getUserToken, getClientToken, getContentKey, getE2EStatus, getServerUrl } from '../../services/storage';
import {
  getSubscription,
  redeemCode,
  type Tier,
  type UsageSnapshot,
} from '../../services/subscription';
import { ensureUserToken } from '../../services/auth';

const app = getApp<any>();

// UI state for the subscription card. 'paid' / 'trial' / 'free'
// mirror the server's Entitlement.tier; 'unauthenticated' and
// 'load_failed' are local-only states we surface so the user can
// tell the difference between "not logged in yet" and "the server
// call failed" (review #17).
type SubscriptionUiState = Tier | 'unauthenticated' | 'load_failed';

// Quota bar coloring tier:
//   normal    — < 40/50, default tint
//   approaching — 40-49, yellow warning ("接近额度上限")
//   exhausted — 50/50, red ("本月已用完")
type QuotaState = 'normal' | 'approaching' | 'exhausted' | 'hidden';

interface PageData {
  deviceId: string;
  tier: SubscriptionUiState;
  plan: string;
  expiresAt: string; // formatted for display, or ''
  daysRemaining: number | null; // for trial: days until expiresAt
  isExpiringSoon: boolean; // paid tier with <= 3 days remaining (P4.1.2)
  usage: UsageSnapshot | null;
  quotaState: QuotaState;
  quotaPercent: number; // 0-100, used for progress bar width
  redeemInput: string;
  redeemBusy: boolean;
  loaded: boolean;
  hasE2EKey: boolean;
  e2eStatus: 'enabled' | 'stale' | 'disabled';
}

Page({
  data: {
    deviceId: '',
    tier: 'unauthenticated',
    plan: '',
    expiresAt: '',
    daysRemaining: null,
    isExpiringSoon: false,
    usage: null,
    quotaState: 'hidden',
    quotaPercent: 0,
    redeemInput: '',
    redeemBusy: false,
    loaded: false,
    hasE2EKey: false,
    e2eStatus: 'disabled',
  } as PageData,

  onShow() {
    this.setData({
      deviceId: getDeviceId() || '',
      hasE2EKey: !!getContentKey(),
      e2eStatus: getE2EStatus(),
    });
    this.refreshSubscription();
  },

  onUnload() {
    // Best-effort cleanup; the page may unmount when the user
    // navigates away mid-refresh.
    if (this._onQuotaExceededBound) {
      app.offWsEvent('quota_exceeded', this._onQuotaExceededBound);
      this._onQuotaExceededBound = undefined;
    }
  },

  goBack() {
    wx.navigateBack();
  },

  unbindDevice() {
    wx.showModal({
      title: '解绑设备',
      content: '确定要解绑此设备吗？',
      success: (res) => {
        if (res.confirm) {
          const deviceId = this.data.deviceId || getDeviceId();
          const token = getUserToken();
          const clientToken = getClientToken();
          if (!deviceId || !token) {
            wx.showToast({ title: '未登录', icon: 'none' });
            return;
          }
          const base = getServerUrl();
          const api = base.endsWith('/api/v1') ? base : `${base}/api/v1`;
          wx.request({
            method: 'DELETE',
            url: `${api}/user/devices/${deviceId}`,
            timeout: 10000,
            header: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${token}`,
              ...(clientToken ? { 'X-Codekey-Client-Token': clientToken } : {}),
            },
            success: (resp: any) => {
              if (resp.statusCode >= 400) {
                const message = resp.data?.error || '解绑失败';
                wx.showToast({ title: message, icon: 'none' });
                return;
              }
              clearAuth();
              app.destroyWs();
              wx.reLaunch({ url: '/pages/login/login' });
            },
            fail: () => {
              wx.showToast({ title: '网络错误，解绑失败', icon: 'none' });
            },
          });
        }
      },
    });
  },

  copyDeviceId() {
    wx.setClipboardData({
      data: this.data.deviceId,
      success: () => wx.showToast({ title: '已复制', icon: 'success' }),
    });
  },

  async refreshSubscription() {
    // Make sure we have a user_token before asking. ensureUserToken
    // is silent on subsequent calls (idempotent).
    try {
      await ensureUserToken();
    } catch (err) {
      // Not logged in (no clientToken yet, or the user is not
      // bound to this device) — surface as unauthenticated so the
      // UI can show "未登录" instead of a generic error.
      this.setData({ tier: 'unauthenticated', loaded: true });
      this._installQuotaListener();
      return;
    }
    if (!getUserToken()) {
      this.setData({ tier: 'unauthenticated', loaded: true });
      this._installQuotaListener();
      return;
    }
    try {
      const sub = await getSubscription();
      this.applySubscription(sub);
    } catch (err) {
      console.warn('[settings] getSubscription failed:', err);
      // Server reachable (we have a token) but the call failed —
      // most likely a network blip. Tell the user it's a load
      // failure, not an auth issue, so they know to retry.
      this.setData({ tier: 'load_failed', loaded: true });
    }
    this._installQuotaListener();
  },

  applySubscription(sub: {
    tier: Tier;
    plan: string | null;
    expiresAt: string | null;
    usage: UsageSnapshot | null;
  }) {
    const tier = sub.tier;
    const expiresAt = sub.expiresAt ? new Date(sub.expiresAt) : null;
    const daysRemaining = expiresAt ? this._daysFromNow(expiresAt) : null;

    // Quota bar is only meaningful for free users — paid/trial are
    // unlimited. For the Free tier, the server returns a usage
    // snapshot; for paid/trial it returns null, so quotaState is
    // 'hidden'.
    const usage = tier === 'free' ? sub.usage : null;
    const quotaState: QuotaState = !usage
      ? 'hidden'
      : usage.used >= usage.limit
        ? 'exhausted'
        : usage.used >= Math.floor(usage.limit * 0.8)
          ? 'approaching'
          : 'normal';
    const quotaPercent = usage
      ? Math.min(100, Math.round((usage.used / usage.limit) * 100))
      : 0;
    const isExpiringSoon = tier === 'paid'
      && daysRemaining != null
      && daysRemaining >= 0
      && daysRemaining <= 3;

    this.setData({
      tier,
      plan: sub.plan ?? '',
      expiresAt: expiresAt ? this.formatDate(expiresAt) : '',
      daysRemaining,
      isExpiringSoon,
      usage,
      quotaState,
      quotaPercent,
      loaded: true,
    });
  },

  /** Compute whole-day delta from "now" to the given future date.
   *  Positive = days remaining; 0 = today; negative = already
   *  expired (treat as "已到期" by the render layer). */
  _daysFromNow(target: Date): number {
    const ms = target.getTime() - Date.now();
    return Math.ceil(ms / 86_400_000);
  },

  /** Subscribe to quota_exceeded exactly once; the handler just
   *  re-fetches so the bar updates immediately rather than waiting
   *  for the next onShow. The 5s toast debounce in app.ts prevents
   *  a UI flood. */
  _installQuotaListener() {
    if (this._onQuotaExceededBound) return;
    this._onQuotaExceededBound = () => {
      this.refreshSubscription();
    };
    app.onWsEvent('quota_exceeded', this._onQuotaExceededBound);
  },

  onRedeemInput(e: any) {
    this.setData({ redeemInput: (e.detail.value || '').toUpperCase() });
  },

  async submitRedeem() {
    const code = (this.data.redeemInput || '').trim();
    if (!code) {
      wx.showToast({ title: '请输入兑换码', icon: 'none' });
      return;
    }
    this.setData({ redeemBusy: true });
    try {
      const r = await redeemCode(code);
      wx.showToast({ title: `已激活 ${r.plan}`, icon: 'success' });
      this.setData({ redeemInput: '' });
      this.refreshSubscription();
    } catch (err: any) {
      const msg =
        err?.error === 'invalid_format' ? '兑换码格式不正确' :
        err?.error === 'not_found' ? '兑换码无效' :
        err?.error === 'already_used' ? '兑换码已被使用' :
        err?.error === 'void' ? '兑换码已作废' :
        err?.error === 'product_mismatch' ? '兑换码与产品不匹配' :
        '兑换失败';
      wx.showToast({ title: msg, icon: 'none' });
    } finally {
      this.setData({ redeemBusy: false });
    }
  },

  formatDate(d: Date): string {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  },
});

