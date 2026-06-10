const DEVICE_ID_KEY = 'CODEKEY_TG_DEVICE_ID';
const CLIENT_TOKEN_KEY = 'CODEKEY_TG_CLIENT_TOKEN';

export function getDeviceId(): string | null {
  return sessionStorage.getItem(DEVICE_ID_KEY);
}

export function getClientToken(): string | null {
  return sessionStorage.getItem(CLIENT_TOKEN_KEY);
}

export function setDeviceCredentials(deviceId: string, clientToken: string): void {
  sessionStorage.setItem(DEVICE_ID_KEY, deviceId);
  sessionStorage.setItem(CLIENT_TOKEN_KEY, clientToken);
}

export function clearDeviceCredentials(): void {
  sessionStorage.removeItem(DEVICE_ID_KEY);
  sessionStorage.removeItem(CLIENT_TOKEN_KEY);
}
