const DEVICE_ID_KEY = 'CODEKEY_TG_DEVICE_ID';
const CLIENT_TOKEN_KEY = 'CODEKEY_TG_CLIENT_TOKEN';
const CONTENT_KEY_KEY = 'CODEKEY_TG_CONTENT_KEY';
const KEY_ID_KEY = 'CODEKEY_TG_KEY_ID';

function getStoredValue(key: string): string | null {
  return sessionStorage.getItem(key) || localStorage.getItem(key);
}

function setStoredValue(key: string, value: string): void {
  sessionStorage.setItem(key, value);
  localStorage.setItem(key, value);
}

function removeStoredValue(key: string): void {
  sessionStorage.removeItem(key);
  localStorage.removeItem(key);
}

export function getDeviceId(): string | null {
  return getStoredValue(DEVICE_ID_KEY);
}

export function getClientToken(): string | null {
  return getStoredValue(CLIENT_TOKEN_KEY);
}

export function setDeviceCredentials(deviceId: string, clientToken: string): void {
  setStoredValue(DEVICE_ID_KEY, deviceId);
  setStoredValue(CLIENT_TOKEN_KEY, clientToken);
}

export function getContentKey(): string | null {
  return getStoredValue(CONTENT_KEY_KEY);
}

export function getKeyId(): string | null {
  return getStoredValue(KEY_ID_KEY);
}

export function setContentKey(contentKeyHex: string, keyId: string): void {
  if (contentKeyHex) setStoredValue(CONTENT_KEY_KEY, contentKeyHex);
  if (keyId) setStoredValue(KEY_ID_KEY, keyId);
}

export function clearContentKey(): void {
  removeStoredValue(CONTENT_KEY_KEY);
  removeStoredValue(KEY_ID_KEY);
}

export function clearDeviceCredentials(): void {
  removeStoredValue(DEVICE_ID_KEY);
  removeStoredValue(CLIENT_TOKEN_KEY);
  clearContentKey();
}
