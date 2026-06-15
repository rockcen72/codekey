const KEYS = {
  CLIENT_TOKEN: 'CODEKEY_CLIENT_TOKEN',
  DEVICE_ID: 'CODEKEY_DEVICE_ID',
  SERVER_URL: 'CODEKEY_SERVER_URL',
  USER_TOKEN: 'CODEKEY_USER_TOKEN',
  USER_ID: 'CODEKEY_USER_ID',
  CONTENT_KEY: 'CODEKEY_CONTENT_KEY',
  KEY_ID: 'CODEKEY_KEY_ID',
  E2E_STATUS: 'CODEKEY_E2E_STATUS',
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

export function saveContentKey(contentKeyHex: string, keyId: string): void {
  wx.setStorageSync(KEYS.CONTENT_KEY, contentKeyHex);
  wx.setStorageSync(KEYS.KEY_ID, keyId);
  if (contentKeyHex) setE2EStatus('enabled'); // re-pair resets stale → enabled
}

export function getContentKey(): string | null {
  return wx.getStorageSync(KEYS.CONTENT_KEY) || null;
}

export function getKeyId(): string | null {
  return wx.getStorageSync(KEYS.KEY_ID) || null;
}

export function getE2EStatus(): 'enabled' | 'stale' | 'disabled' {
  return (wx.getStorageSync(KEYS.E2E_STATUS) as 'enabled' | 'stale' | 'disabled') || 'disabled';
}

export function setE2EStatus(status: 'enabled' | 'stale' | 'disabled'): void {
  wx.setStorageSync(KEYS.E2E_STATUS, status);
}

export function clearContentKey(): void {
  wx.removeStorageSync(KEYS.CONTENT_KEY);
  wx.removeStorageSync(KEYS.KEY_ID);
  wx.removeStorageSync(KEYS.E2E_STATUS);
}

export function clearAuth(): void {
  wx.removeStorageSync(KEYS.CLIENT_TOKEN);
  wx.removeStorageSync(KEYS.DEVICE_ID);
  clearContentKey();
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
