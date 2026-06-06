import type { PropsWithChildren } from 'react';
import { useEffect } from 'react';

export function ThemeProvider({ children }: PropsWithChildren) {
  useEffect(() => {
    const params = window.Telegram?.WebApp.themeParams ?? {};
    const root = document.documentElement;
    for (const [key, value] of Object.entries(params)) {
      if (value) root.style.setProperty(`--tg-${key.replaceAll('_', '-')}`, value);
    }
  }, []);

  return <>{children}</>;
}
