const DEVICE_ID_KEY = 'CODEKEY_TG_DEVICE_ID';
const CLIENT_TOKEN_KEY = 'CODEKEY_TG_CLIENT_TOKEN';
const CONTENT_KEY_KEY = 'CODEKEY_TG_CONTENT_KEY';
const KEY_ID_KEY = 'CODEKEY_TG_KEY_ID';
const E2E_STATUS_KEY = 'CODEKEY_TG_E2E_STATUS';

export interface E2EState {
  state: 'enabled' | 'stale' | 'disabled';
  lastServerKeyId: string | null;
  localKeyId: string | null;
  at: number;
  lastToastAt: number;
  lastToastSessionId: string | null;
}

const DEFAULT_E2E_STATE: E2EState = {
  state: 'disabled',
  lastServerKeyId: null,
  localKeyId: null,
  at: 0,
  lastToastAt: 0,
  lastToastSessionId: null,
};

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

function parseE2EState(raw: string | null): E2EState {
  if (!raw) return { ...DEFAULT_E2E_STATE };
  try {
    return { ...DEFAULT_E2E_STATE, ...JSON.parse(raw) };
  } catch {
    return { state: raw as any || 'disabled', lastServerKeyId: null, localKeyId: null, at: Date.now(), lastToastAt: 0, lastToastSessionId: null };
  }
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
  if (contentKeyHex) {
    const current = getE2EState();
    current.state = 'enabled';
    current.localKeyId = keyId || current.localKeyId;
    current.lastServerKeyId = keyId || current.lastServerKeyId;
    current.at = Date.now();
    setStoredValue(E2E_STATUS_KEY, JSON.stringify(current));
  }
}

export function getE2EStatus(): 'enabled' | 'stale' | 'disabled' {
  return getE2EState().state;
}

export function setE2EStatus(status: 'enabled' | 'stale' | 'disabled'): void {
  const current = getE2EState();
  current.state = status;
  current.at = Date.now();
  setStoredValue(E2E_STATUS_KEY, JSON.stringify(current));
}

export function getE2EState(): E2EState {
  return parseE2EState(getStoredValue(E2E_STATUS_KEY));
}

export function setE2EState(partial: Partial<E2EState> & { state: 'enabled' | 'stale' | 'disabled' }): void {
  const current = getE2EState();
  Object.assign(current, partial, { at: Date.now() });
  setStoredValue(E2E_STATUS_KEY, JSON.stringify(current));
}

export function clearContentKey(): void {
  removeStoredValue(CONTENT_KEY_KEY);
  removeStoredValue(KEY_ID_KEY);
  removeStoredValue(E2E_STATUS_KEY);
}

export function clearDeviceCredentials(): void {
  removeStoredValue(DEVICE_ID_KEY);
  removeStoredValue(CLIENT_TOKEN_KEY);
  clearContentKey();
}
