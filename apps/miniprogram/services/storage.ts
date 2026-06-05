const KEYS = {
  CLIENT_TOKEN: 'CODEKEY_CLIENT_TOKEN',
  DEVICE_ID: 'CODEKEY_DEVICE_ID',
  SERVER_URL: 'CODEKEY_SERVER_URL',
  USER_TOKEN: 'CODEKEY_USER_TOKEN',
  USER_ID: 'CODEKEY_USER_ID',
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

export function saveUserToken(token: string, userId: number): void {
  wx.setStorageSync(KEYS.USER_TOKEN, token);
  wx.setStorageSync(KEYS.USER_ID, userId);
}

export function getUserToken(): string | null {
  return wx.getStorageSync(KEYS.USER_TOKEN) || null;
}

export function getUserId(): number | null {
  const v = wx.getStorageSync(KEYS.USER_ID);
  return typeof v === 'number' && v > 0 ? v : null;
}

export function clearUserToken(): void {
  wx.removeStorageSync(KEYS.USER_TOKEN);
  wx.removeStorageSync(KEYS.USER_ID);
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
