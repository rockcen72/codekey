import { getDeviceId, getServerUrl, clearAuth } from '../../services/storage';

const app = getApp();

Page({
  data: {
    deviceId: '',
    serverUrl: '',
  },

  onShow() {
    this.setData({
      deviceId: getDeviceId() || '',
      serverUrl: getServerUrl(),
    });
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
          const ws = app.globalData.ws as any;
          if (ws) { ws.disconnect(); }
          app.globalData.ws = null;
          app.globalData.wsConnected = false;
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
});
