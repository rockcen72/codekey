import { getDeviceId, clearAuth, getUserToken, getClientToken, getContentKey, getE2EStatus, getServerUrl, hasAuth } from '../../services/storage';
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
  isPaired: boolean;
  manualCode: string;
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
    isPaired: false,
    manualCode: '',
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
    const paired = hasAuth();
    this.setData({
      isPaired: paired,
      deviceId: getDeviceId() || '',
      hasE2EKey: !!getContentKey(),
      e2eStatus: getE2EStatus(),
    });
    if (paired) {
      this.refreshSubscription();
    } else {
      this.setData({ tier: 'unauthenticated', loaded: true });
    }
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
    tt.navigateBack();
  },

  startScan() {
    tt.scanCode({
      onlyFromCamera: true,
      success: (res) => {
        const raw = res.result.trim();
        // Try several QR code formats, in order of preference:
        // 1. Feishu deep link: feishu://...?query=code%3DXXX%26...
        // 2. WeChat-style URL: codekey://pair?code=XXX
        // 3. Direct 8-char code: XXXXXXXX
        let code = '';
        let keyId = '';
        let contentKey = '';
        // Check for feishu deep link with encoded query= param
        const feishuQueryMatch = raw.match(/[?&]query=([^&]+)/i);
        if (feishuQueryMatch) {
          const decoded = decodeURIComponent(feishuQueryMatch[1]);
          const codeMatch = decoded.match(/code=([A-Z2-9]{8})/i);
          if (codeMatch) {
            code = codeMatch[1].toUpperCase();
            const keyIdMatch = decoded.match(/key_id=([^&]+)/i);
            const contentKeyMatch = decoded.match(/content_key=([^&]+)/i);
            if (keyIdMatch) keyId = keyIdMatch[1];
            if (contentKeyMatch) contentKey = contentKeyMatch[1];
          }
        }
        // Fallback: direct code= param (WeChat / codekey:// scheme)
        if (!code) {
          const urlMatch = raw.match(/[?&]code=([A-Z2-9]{8})(?:$|&)/i);
          if (urlMatch) {
            code = urlMatch[1].toUpperCase();
            const keyIdMatch = raw.match(/[?&]key_id=([^&]+)/i);
            const contentKeyMatch = raw.match(/[?&]content_key=([^&]+)/i);
            if (keyIdMatch) keyId = keyIdMatch[1];
            if (contentKeyMatch) contentKey = contentKeyMatch[1];
          }
        }
        // Last resort: raw 8-char code
        if (!code && /^[A-Z2-9]{8}$/i.test(raw)) {
          code = raw.toUpperCase();
        }
        if (code) {
          let url = `/pages/bind/bind?code=${code}`;
          if (keyId) url += `&key_id=${encodeURIComponent(keyId)}`;
          if (contentKey) url += `&content_key=${encodeURIComponent(contentKey)}`;
          tt.navigateTo({ url });
        } else {
          tt.showToast({ title: '无效的配对码', icon: 'none' });
        }
      },
      fail: (err) => {
        tt.showToast({ title: '扫码失败：' + (err.errMsg || '未知错误'), icon: 'none' });
      },
    });
  },

  onCodeInput(e: any) {
    this.setData({ manualCode: e.detail.value.toUpperCase() });
  },

  confirmManualCode() {
    const code = this.data.manualCode.trim().toUpperCase();
    if (code.length === 8 && /^[A-Z2-9]+$/.test(code)) {
      tt.navigateTo({ url: `/pages/bind/bind?code=${code}` });
    } else {
      tt.showToast({ title: '配对码必须为 8 位字符', icon: 'none' });
    }
  },

  unbindDevice() {
    tt.showModal({
      title: '解绑设备',
      content: '确定要解绑此设备吗？',
      success: (res) => {
        if (res.confirm) {
          const deviceId = this.data.deviceId || getDeviceId();
          const token = getUserToken();
          const clientToken = getClientToken();
          if (!deviceId || !token) {
            tt.showToast({ title: '未登录', icon: 'none' });
            return;
          }
          const base = getServerUrl();
          const api = base.endsWith('/api/v1') ? base : `${base}/api/v1`;
          tt.request({
            method: 'DELETE',
            url: `${api}/user/devices/${deviceId}`,
            timeout: 10000,
            // 注意：DELETE 不带 body。tt.request header 默认带 'content-type: application/json',
            // 而 fastify 4.x 看到 application/json + 空 body 会返回 400 FST_ERR_CTP_EMPTY_JSON_BODY。
            // 显式覆盖 content-type 为 text/plain 来绕过这个默认行为。
            // 参考 telegram-miniapp/src/api/client.ts: 仅在有 body 时才设 application/json。
            header: {
              'content-type': 'text/plain',
              'Authorization': `Bearer ${token}`,
              ...(clientToken ? { 'X-Codekey-Client-Token': clientToken } : {}),
            },
            success: (resp: any) => {
              if (resp.statusCode >= 400) {
                // client_token_invalid / client_token_required 都意味着服务端
                // 已经认为这个设备解绑了（token 被撤销，或绑定记录已 unbound_at）。
                // 用户的目标就是解绑，本地静默清理即可，不要弹错误提示。
                // 404 device not found 同理（绑定已被删除）。
                const errCode = resp.data?.error;
                const treatAsUnbound =
                  errCode === 'client_token_invalid' ||
                  errCode === 'client_token_required' ||
                  resp.statusCode === 404;
                if (treatAsUnbound) {
                  console.warn('[settings] device already unbound on server, clearing local auth', errCode);
                  clearAuth();
                  app.destroyWs();
                  tt.reLaunch({ url: '/pages/sessions/sessions' });
                  return;
                }
                // 后端 200/4xx 都返回 JSON; fastify 的默认 400 形如
                // { statusCode, error: 'Bad Request', message: '...' }
                // 应用层错误形如 { error: 'client_token_required' }
                const message = resp.data?.message || resp.data?.error || `解绑失败 (${resp.statusCode})`;
                tt.showToast({ title: message, icon: 'none', duration: 3000 });
                console.warn('[settings] unbind failed', resp.statusCode, resp.data);
                return;
              }
              clearAuth();
              app.destroyWs();
              tt.reLaunch({ url: '/pages/sessions/sessions' });
            },
            fail: (err: any) => {
              console.warn('[settings] unbind network error', err);
              tt.showToast({ title: '网络错误：' + (err?.errMsg || '解绑失败'), icon: 'none', duration: 3000 });
            },
          });
        }
      },
    });
  },

  copyDeviceId() {
    tt.setClipboardData({
      data: this.data.deviceId,
      success: () => tt.showToast({ title: '已复制', icon: 'success' }),
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
      tt.showToast({ title: '请输入兑换码', icon: 'none' });
      return;
    }
    this.setData({ redeemBusy: true });
    try {
      const r = await redeemCode(code);
      tt.showToast({ title: `已激活 ${r.plan}`, icon: 'success' });
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
      tt.showToast({ title: msg, icon: 'none' });
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

