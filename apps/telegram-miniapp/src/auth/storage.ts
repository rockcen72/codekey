const TOKEN_KEY = 'CODEKEY_TG_USER_TOKEN';

export function getUserToken(): string | null {
  return sessionStorage.getItem(TOKEN_KEY);
}

export function setUserToken(token: string): void {
  sessionStorage.setItem(TOKEN_KEY, token);
}

export function clearUserToken(): void {
  sessionStorage.removeItem(TOKEN_KEY);
}
