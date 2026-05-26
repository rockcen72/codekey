Page({
  data: {
    code: '',
    status: 'binding', // binding | success | failed
    errorMsg: '',
  },

  onLoad(options: { code?: string }) {
    if (options.code) {
      this.setData({ code: options.code });
      this.confirmBind();
    }
  },

  confirmBind() {
    // TODO: POST /api/v1/devices/confirm
    wx.showLoading({ title: '绑定中...' });

    // Mock:
    setTimeout(() => {
      wx.hideLoading();
      this.setData({ status: 'success' });
      setTimeout(() => {
        wx.redirectTo({ url: '/pages/sessions/sessions' });
      }, 1500);
    }, 1000);
  },
});
