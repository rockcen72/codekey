const KEYS = {
  CLIENT_TOKEN: 'CODEKEY_CLIENT_TOKEN',
  DEVICE_ID: 'CODEKEY_DEVICE_ID',
  SERVER_URL: 'CODEKEY_SERVER_URL',
};

export function saveAuth(clientToken: string, deviceId: string): void {
  wx.setStorageSync(KEYS.CLIENT_TOKEN, clientToken);
  wx.setStorageSync(KEYS.DEVICE_ID, deviceId);
}

export function getClientToken(): string | null {
  return wx.getStorageSync(KEYS.CLIENT_TOKEN) || null;
}

export function getDeviceId(): string | null {
  return wx.getStorageSync(KEYS.DEVICE_ID) || null;
}

export function clearAuth(): void {
  wx.removeStorageSync(KEYS.CLIENT_TOKEN);
  wx.removeStorageSync(KEYS.DEVICE_ID);
}

export function hasAuth(): boolean {
  return !!getClientToken();
}

export function getServerUrl(): string {
  return wx.getStorageSync(KEYS.SERVER_URL) || 'https://codekey.tinymoney.cn';
}

export function setServerUrl(url: string): void {
  wx.setStorageSync(KEYS.SERVER_URL, url);
}
