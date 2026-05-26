Page({
  data: {
    canScan: false,
  },

  onLoad() {
    // TODO: check if already bound
  },

  startScan() {
    // TODO: open QR code scanner
    wx.scanCode({
      success: (res) => {
        const code = res.result;
        wx.navigateTo({ url: `/pages/bind/bind?code=${code}` });
      },
    });
  },
});
