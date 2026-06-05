import { getDeviceId, clearAuth, getUserToken } from '../../services/storage';
import { getSubscription, redeemCode, type SubscriptionStatus, type Tier } from '../../services/subscription';
import { ensureUserToken } from '../../services/auth';

const app = getApp<any>();

interface PageData {
  deviceId: string;
  tier: Tier | 'unknown';
  plan: string;
  expiresAt: string; // formatted for display, or ''
  redeemInput: string;
  redeemBusy: boolean;
  loaded: boolean;
}

Page({
  data: {
    deviceId: '',
    tier: 'unknown',
    plan: '',
    expiresAt: '',
    redeemInput: '',
    redeemBusy: false,
    loaded: false,
  } as PageData,

  onShow() {
    this.setData({
      deviceId: getDeviceId() || '',
    });
    this.refreshSubscription();
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
          // Local-only unbind: mini program uses clientToken which the
          // server's DELETE /devices/:id endpoint does not accept.
          // Clear local auth and disconnect WS.
          clearAuth();
          app.destroyWs();
          wx.reLaunch({ url: '/pages/login/login' });
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
      // Not logged in / no device yet — just hide the subscription
      // section. The user can pair a device first to enable it.
      this.setData({ tier: 'unknown', loaded: true });
      return;
    }
    if (!getUserToken()) {
      this.setData({ tier: 'unknown', loaded: true });
      return;
    }
    try {
      const sub = await getSubscription();
      this.setData({
        tier: sub.tier,
        plan: sub.plan ?? '',
        expiresAt: sub.expiresAt ? this.formatDate(new Date(sub.expiresAt)) : '',
        loaded: true,
      });
    } catch (err) {
      console.warn('[settings] getSubscription failed:', err);
      this.setData({ tier: 'unknown', loaded: true });
    }
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

