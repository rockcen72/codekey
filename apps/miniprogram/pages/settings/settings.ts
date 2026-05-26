Page({
  data: {
    devices: [] as Array<{ id: string; name: string; lastSeen: string }>,
  },

  onShow() {
    this.fetchDevices();
  },

  fetchDevices() {
    // TODO: GET /api/v1/devices
  },

  unbindDevice(e: { currentTarget: { dataset: { id: string } } }) {
    wx.showModal({
      title: '确认解绑',
      content: '解绑后该设备将无法接收通知',
      success: (res) => {
        if (res.confirm) {
          // TODO: DELETE /api/v1/devices/:id
        }
      },
    });
  },
});
