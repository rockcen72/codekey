import { getClientToken, getDeviceId, getServerUrl } from './services/storage';

App({
  globalData: {
    serverUrl: getServerUrl(),
    clientToken: getClientToken() || '',
    deviceId: getDeviceId() || '',
    ws: null as any,
    wsConnected: false,
  },
  onLaunch() {
    // Auth state restored synchronously via getClientToken/getDeviceId
    // in globalData initializer above
  },
});
