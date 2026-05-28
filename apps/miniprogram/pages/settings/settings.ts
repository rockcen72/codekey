import { getDeviceId, getServerUrl, setServerUrl, clearAuth } from '../../services/storage';

const app = getApp<any>();

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
    // Re-init WS with new URL
    app.destroyWs();
    app.initWs();
    wx.showToast({ title: '已保存，重新连接中', icon: 'success' });
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
});
