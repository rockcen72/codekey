export const APP_NAME = 'codekey';

export const RELAY_DEFAULT_URL = 'wss://api.codekey.dev';

export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_CODE_TTL_MS = 5 * 60 * 1000; // 5 min

export const HEARTBEAT_INTERVAL_MS = 15_000;
export const HEARTBEAT_TIMEOUT_MS = 45_000; // 3 missed pings

export const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 min
export const EVENT_RETENTION_DAYS = 30;

export const CONTEXT_SNIPPET_MAX_LINES = 20;
export const EVENT_EXPIRY_MS = 5 * 60 * 1000; // 5 min per approval event

export const RECONNECT_BASE_DELAY_MS = 1_000;
export const RECONNECT_MAX_DELAY_MS = 30_000;

export const ERROR_CODES = {
  DEVICE_NOT_FOUND: 'DEVICE_NOT_FOUND',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  RISK_TOO_HIGH: 'RISK_TOO_HIGH',
  SESSION_EXPIRED: 'SESSION_EXPIRED',
  RATE_LIMITED: 'RATE_LIMITED',
  EVENT_EXPIRED: 'EVENT_EXPIRED',
  DUPLICATE_RESPONSE: 'DUPLICATE_RESPONSE',
  ADAPTER_ERROR: 'ADAPTER_ERROR',
} as const;

export const CREDENTIALS_PATH = '.codekey/credentials.json';
