// Feishu mini program global type declarations.
// Minimal stubs to satisfy tsc — the real types come from the Feishu runtime.

declare const tt: any;
declare const App: (options: any) => any;
declare const Page: (options: any) => any;
declare const Component: (options: any) => any;
declare const getApp: <T = any>() => T;
declare const getCurrentPages: () => any[];
declare const requirePlugin: (name: string) => any;

// Browser/Node globals not in lib.es2020 (we don't use lib.dom because feishu IDE doesn't ship it)
declare const console: {
  log(...args: any[]): void;
  warn(...args: any[]): void;
  error(...args: any[]): void;
  info(...args: any[]): void;
  debug(...args: any[]): void;
};
declare function setTimeout(handler: () => void, timeout?: number): number;
declare function clearTimeout(handle: number): void;
declare function setInterval(handler: () => void, timeout?: number): number;
declare function clearInterval(handle: number): void;
declare function btoa(s: string): string;
declare function atob(s: string): string;
declare function require(path: string): any;
declare const crypto: { getRandomValues(arr: Uint8Array): Uint8Array };

