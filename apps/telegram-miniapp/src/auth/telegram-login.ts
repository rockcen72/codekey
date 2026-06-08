import { publicRequest } from '../api/client';
import type { TelegramLoginResult } from '../api/types';
import { setUserToken } from './storage';

async function waitForInitData(): Promise<string> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const initData = window.Telegram?.WebApp.initData;
    if (initData) return initData;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Telegram initData not detected. Please open this from a Telegram Mini App button.');
}

export async function loginWithTelegram(): Promise<TelegramLoginResult> {
  const initData = await waitForInitData();

  const result = await publicRequest<TelegramLoginResult>('/auth/telegram', {
    method: 'POST',
    body: JSON.stringify({ initData }),
  });
  setUserToken(result.token);
  return result;
}
