import { createApi } from '../../services/api';
import { saveAuth, getServerUrl } from '../../services/storage';

const app = getApp<any>();

Page({
  data: {
    code: '',
    status: 'binding' as 'binding' | 'success' | 'failed',
    errorMsg: '',
  },

  onLoad(query: any) {
    const code = query.code || '';
    const platform: 'wechat' | 'feishu' = query.platform === 'feishu' ? 'feishu' : 'wechat';
    this.setData({ code, platform });
    this.confirmBind(code, platform);
  },

  async confirmBind(code: string, platform: 'wechat' | 'feishu') {
    this.setData({ status: 'binding', errorMsg: '' });
    try {
      const api = createApi(getServerUrl());
      const result = await api.confirmCode(code, platform);
      saveAuth(result.clientToken, result.deviceId);
      app.destroyWs();
      app.initWs();
      this.setData({ status: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/sessions/sessions' });
      }, 1500);
    } catch (err: any) {
      const msg = err?.error === 'RATE_LIMITED'
        ? '操作太频繁，请稍后再试'
        : err?.error === 'invalid or expired code'
          ? '配对码已过期或已使用'
          : '绑定失败：' + (err?.error || '未知错误');
      this.setData({ status: 'failed', errorMsg: msg });
    }
  },

  retry() {
    wx.navigateBack();
  },
});
