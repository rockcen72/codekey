/// <reference types="vite/client" />

interface TelegramWebApp {
  initData: string;
  ready(): void;
  expand(): void;
  close(): void;
  themeParams?: Record<string, string>;
  MainButton?: {
    setText(text: string): void;
    show(): void;
    hide(): void;
    enable(): void;
    disable(): void;
    showProgress(leaveActive?: boolean): void;
    hideProgress(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
  BackButton?: {
    show(): void;
    hide(): void;
    onClick(callback: () => void): void;
    offClick(callback: () => void): void;
  };
}

interface Window {
  Telegram?: {
    WebApp: TelegramWebApp;
  };
}
