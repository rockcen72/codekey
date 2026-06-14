export interface ParsedPairingStartParam {
  code: string;
  keyId?: string;
  contentKey?: string;
}

const EMBEDDED_KEY_RE = /^ck_([0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12})_([0-9a-f]{64})_([A-Z0-9]{8})$/i;
const COMPACT_KEY_RE = /^ck_([A-Za-z0-9_-]{43})_([A-Z0-9]{8})$/i;
const CODE_RE = /^[A-Z0-9]{8}$/i;

function base64UrlToHex(value: string): string | null {
  try {
    const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
    const padded = base64.padEnd(base64.length + ((4 - base64.length % 4) % 4), '=');
    const binary = atob(padded);
    if (binary.length !== 32) return null;
    return Array.from(binary, (char) => char.charCodeAt(0).toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

export function getTelegramStartParam(params: URLSearchParams): string {
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param
    || params.get('tgWebAppStartParam')
    || params.get('startapp')
    || '';
}

export function parsePairingStartParam(value: string): ParsedPairingStartParam | null {
  const embedded = EMBEDDED_KEY_RE.exec(value);
  if (embedded) {
    const rawKeyId = embedded[1];
    return {
      keyId: rawKeyId.length === 32
        ? `${rawKeyId.slice(0, 8)}-${rawKeyId.slice(8, 12)}-${rawKeyId.slice(12, 16)}-${rawKeyId.slice(16, 20)}-${rawKeyId.slice(20)}`
        : rawKeyId,
      contentKey: embedded[2],
      code: embedded[3],
    };
  }
  const compact = COMPACT_KEY_RE.exec(value);
  if (compact) {
    const contentKey = base64UrlToHex(compact[1]);
    if (!contentKey) return null;
    return {
      keyId: contentKey.slice(0, 16),
      contentKey,
      code: compact[2],
    };
  }
  if (CODE_RE.test(value)) {
    return { code: value.toUpperCase() };
  }
  return null;
}
