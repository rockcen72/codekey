import { hasAuth } from '../../services/storage';

Page({
  data: {
    canScan: true,
    showManualInput: false,
    manualCode: '',
  },

  onLoad() {
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
});
