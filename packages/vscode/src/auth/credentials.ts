import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { CREDENTIALS_PATH } from '@codekey/shared';

export interface Credentials {
  deviceId: string;
  deviceSecret: string;
  deviceToken?: string;
  relayUrl: string;
}

function credentialsPath(): string {
  return path.join(os.homedir(), CREDENTIALS_PATH);
}

export function loadCredentials(): Credentials | null {
  try {
    const raw = fs.readFileSync(credentialsPath(), 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed.deviceId || !parsed.deviceSecret) {
      // Missing required fields → treat as unpaired, force re-pair.
      return null;
    }
    return {
      deviceId: parsed.deviceId,
      deviceSecret: parsed.deviceSecret,
      deviceToken: typeof parsed.deviceToken === 'string' ? parsed.deviceToken : undefined,
      // Empty relayUrl is intentional — callers (pair.ts, sidebar-provider)
      // must decide what to do. Do NOT fall back to a hardcoded IP here;
      // that's a security regression (P1-1).
      relayUrl: typeof parsed.relayUrl === 'string' ? parsed.relayUrl : '',
    };
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  try {
    fs.unlinkSync(credentialsPath());
  } catch {}
}

export function saveCredentials(creds: Credentials): void {
  const dir = path.dirname(credentialsPath());
  fs.mkdirSync(dir, { recursive: true });
  const filePath = credentialsPath();
  fs.writeFileSync(filePath, JSON.stringify(creds, null, 2), {
    mode: 0o600,
    encoding: 'utf-8',
  });
  // Windows ignores the mode option; chmodSync is a no-op there. POSIX
  // filesystems honor the mode, but call chmodSync as a belt-and-suspenders
  // fallback (some umask configurations can mask the requested bits).
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Best-effort: if chmod fails, the file is still saved with mode from
      // writeFileSync. Don't crash the credential-save path.
    }
  }
}
