import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CREDENTIALS_PATH } from '@codekey/shared';

export interface DeviceCredentials {
  deviceId: string;
  deviceSecret: string;
}

const CREDENTIALS_FILE = resolve(homedir(), CREDENTIALS_PATH);

export class DeviceSecretManager {
  private credentials: DeviceCredentials | null = null;

  /** Load existing credentials or create new ones (first-time bootstrap). */
  loadOrCreate(): DeviceCredentials & { isNew: boolean } {
    if (this.credentials) return { ...this.credentials, isNew: false };

    if (existsSync(CREDENTIALS_FILE)) {
      const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
      this.credentials = JSON.parse(raw) as DeviceCredentials;
      return { ...this.credentials, isNew: false };
    }

    const credentials: DeviceCredentials = {
      deviceId: randomUUID(),
      deviceSecret: randomBytes(32).toString('base64'),
    };

    const dir = dirname(CREDENTIALS_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(credentials, null, 2), {
      mode: 0o600,
    });

    this.credentials = credentials;
    return { ...credentials, isNew: true };
  }

  getDeviceId(): string {
    return this.loadOrCreate().deviceId;
  }

  getDeviceSecret(): string {
    return this.loadOrCreate().deviceSecret;
  }

  /** Hash the device secret for server-side storage/comparison. */
  hashSecret(secret: string): string {
    return createHash('sha256').update(secret).digest('hex');
  }

  /** After pairing, store the server-assigned deviceId locally. */
  saveDeviceId(deviceId: string): void {
    const creds = this.loadOrCreate();
    this.credentials = { ...creds, deviceId };
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(this.credentials, null, 2), {
      mode: 0o600,
    });
  }

  /** Persist device_token after successful pairing. */
  saveDeviceToken(token: string): void {
    const data = JSON.parse(readFileSync(CREDENTIALS_FILE, 'utf-8'));
    data.deviceToken = token;
    writeFileSync(CREDENTIALS_FILE, JSON.stringify(data, null, 2), {
      mode: 0o600,
    });
  }

  /** Retrieve stored device_token. */
  getDeviceToken(): string | null {
    try {
      const raw = readFileSync(CREDENTIALS_FILE, 'utf-8');
      const data = JSON.parse(raw);
      return data.deviceToken ?? null;
    } catch {
      return null;
    }
  }
}
