import { hasAuth, getServerUrl, setServerUrl } from '../../services/storage';

Page({
  data: {
    canScan: true,
    showManualInput: false,
    manualCode: '',
    showServerInput: false,
    serverUrl: getServerUrl(),
  },

  onLoad(query: any) {
    // Deep link: /pages/login/login?code=ABCD1234
    // Triggered by WeChat native QR scan → "普通链接二维码" rule
    const deepCode = (query.code || decodeURIComponent(query.scene || '')).trim().toUpperCase();
    if (deepCode.length === 8 && /^[A-Z2-9]+$/.test(deepCode)) {
      wx.navigateTo({ url: `/pages/bind/bind?code=${deepCode}` });
      return;
    }

    if (hasAuth()) {
      wx.redirectTo({ url: '/pages/sessions/sessions' });
    }
  },

  startScan() {
    wx.scanCode({
      onlyFromCamera: true,
      success: (res) => {
        const code = res.result.trim();
        if (code.length === 8 && /^[A-Z2-9]+$/.test(code)) {
          wx.navigateTo({ url: `/pages/bind/bind?code=${code}` });
        } else {
          wx.showToast({ title: '无效的配对码', icon: 'none' });
        }
      },
    });
  },

  toggleManualInput() {
    this.setData({ showManualInput: !this.data.showManualInput });
  },

  onCodeInput(e: any) {
    this.setData({ manualCode: e.detail.value });
  },

  confirmManualCode() {
    const code = this.data.manualCode.trim().toUpperCase();
    if (code.length === 8 && /^[A-Z2-9]+$/.test(code)) {
      wx.navigateTo({ url: `/pages/bind/bind?code=${code}` });
    } else {
      wx.showToast({ title: '配对码必须为 8 位字符', icon: 'none' });
    }
  },

  toggleServerInput() {
    this.setData({ showServerInput: !this.data.showServerInput });
  },

  onServerUrlInput(e: any) {
    this.setData({ serverUrl: e.detail.value });
  },

  saveServerUrl() {
    const url = this.data.serverUrl.trim();
    if (!url) {
      wx.showToast({ title: '服务器地址不能为空', icon: 'none' });
      return;
    }
    setServerUrl(url);
    wx.showToast({ title: '服务器地址已保存', icon: 'success' });
  },
});
