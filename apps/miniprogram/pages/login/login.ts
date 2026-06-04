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
        const raw = res.result.trim();
        // 支持直接扫描配对码（8位）或 pairUrl（如 https://domain/pair?code=XXX）
        let code = raw;
        const urlMatch = raw.match(/[?&]code=([A-Z2-9]{8})(?:$|&)/i);
        if (urlMatch) {
          code = urlMatch[1].toUpperCase();
        }
        if (code.length === 8 && /^[A-Z2-9]+$/.test(code)) {
          wx.navigateTo({ url: `/pages/bind/bind?code=${code}` });
        } else {
          wx.showToast({ title: '无效的配对码', icon: 'none' });
        }
      },
      fail: (err) => {
        wx.showToast({ title: '扫码失败：' + (err.errMsg || '未知错误'), icon: 'none' });
      },
    });
  },

  toggleManualInput() {
    this.setData({ showManualInput: !this.data.showManualInput });
  },

  onCodeInput(e: any) {
    // 自动转大写，方便用户核对
    this.setData({ manualCode: e.detail.value.toUpperCase() });
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
