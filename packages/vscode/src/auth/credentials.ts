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
    return {
      deviceId: parsed.deviceId ?? '',
      deviceSecret: parsed.deviceSecret ?? '',
      deviceToken: parsed.deviceToken ?? undefined,
      relayUrl: parsed.relayUrl ?? 'https://81.70.235.58',
    };
  } catch {
    return null;
  }
}

export function saveCredentials(creds: Credentials): void {
  const dir = path.dirname(credentialsPath());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(credentialsPath(), JSON.stringify(creds, null, 2), 'utf-8');
}
