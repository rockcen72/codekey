import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { loadCredentials, saveCredentials, loadDesktopInstallId } from '../auth/credentials.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import type { StatusBar } from '../status/bar.js';
import { log } from '../log.js';
import { secureFetch } from '../util/secure-fetch.js';

export async function pairDevice(_context: vscode.ExtensionContext, statusBar: StatusBar): Promise<void> {
  let channel: vscode.OutputChannel | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 1. Load or create device credentials (first-time bootstrap)
    let creds = loadCredentials();
    const isNew = !creds;

    if (!creds) {
      creds = {
        deviceId: crypto.randomUUID(),
        deviceSecret: crypto.randomBytes(32).toString('base64'),
        relayUrl: 'https://codekey.tinymoney.cn',
      };
      saveCredentials(creds);
    }

    const relayUrl = creds.relayUrl;
    const desktopInstallId = loadDesktopInstallId();
    let deviceSecretHash = crypto.createHash('sha256').update(creds.deviceSecret).digest('hex');
    const hostname = os.hostname();

    // 2. Request pairing code from relay
    const body: Record<string, unknown> = { desktopInstallId, deviceSecretHash, deviceName: hostname };
    if (!isNew) body.deviceId = creds.deviceId;

    let response = await secureFetch(`${relayUrl}/api/v1/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if ((response.status === 403 || response.status === 404) && !isNew) {
      creds = {
        deviceId: crypto.randomUUID(),
        deviceSecret: crypto.randomBytes(32).toString('base64'),
        relayUrl,
      };
      saveCredentials(creds);
      deviceSecretHash = crypto.createHash('sha256').update(creds.deviceSecret).digest('hex');
      response = await secureFetch(`${relayUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desktopInstallId, deviceSecretHash, deviceName: hostname }),
      });
    }

    if (!response.ok) {
      throw new Error(`Pairing request failed: ${await response.text()}`);
    }

    const pairResult = await response.json() as { code: string; deviceId?: string };

    // Save server-assigned deviceId when the relay created a fresh device.
    if (pairResult.deviceId && (isNew || pairResult.deviceId !== creds.deviceId)) {
      creds.deviceId = pairResult.deviceId;
      saveCredentials(creds);
    }

    const effectiveDeviceId = pairResult.deviceId ?? creds.deviceId;

    // 3. Show pairing code to user
    channel = vscode.window.createOutputChannel('CodeKey Pair');
    channel.appendLine('');
    channel.appendLine('┌────────────────────────────────────────────┐');
    channel.appendLine(`│  Pairing Code: ${pairResult.code.padEnd(30)}│`);
    channel.appendLine('│                                            │');
    channel.appendLine('│  Enter this code in WeChat Mini Program    │');
    channel.appendLine('│  Code expires in 5 minutes                 │');
    channel.appendLine('└────────────────────────────────────────────┘');
    channel.appendLine('');
    channel.show();

    // Schedule auto-close after 30s so the output channel doesn't stay active
    // and cause CC extension to pick it up as an @-mention reference.
    closeTimer = setTimeout(() => channel?.dispose(), 30_000);

    vscode.window.showInformationMessage(
      `Pairing code: ${pairResult.code}. Enter it in the WeChat Mini Program.`,
    );

    // 4. Connect to relay WS and wait for device_token
    // Uses native WebSocket (Node.js 18+) — no 'ws' package dependency needed.
    const wsUrl = relayUrl.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/ws?device_id=${effectiveDeviceId}&device_secret=${creds.deviceSecret}`);

    channel.appendLine('Waiting for QR code scan...');

    const deviceToken = await new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error('Pairing timed out after 5 minutes'));
      }, 5 * 60 * 1000);

      ws.addEventListener('message', (event: MessageEvent) => {
        try {
          const raw = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer);
          const msg = JSON.parse(raw);
          if (msg.type === 'device_token') {
            clearTimeout(timeout);
            resolve(msg.payload.deviceToken);
          }
          if (msg.type === 'pairing_ready') {
            channel!.appendLine('QR code scanned! Waiting for confirmation...');
          }
        } catch { /* skip malformed */ }
      });

      ws.addEventListener('error', () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed'));
      });

      ws.addEventListener('close', () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket closed before pairing completed'));
      });
    });

    // 5. Save deviceToken and notify user
    const final = loadCredentials()!;
    final.deviceToken = deviceToken;
    saveCredentials(final);

    clearTimeout(closeTimer);
    channel.appendLine('✓ Binding successful! Device connected.');
    channel.dispose();
    vscode.window.showInformationMessage('CodeKey paired successfully!');

    // Restart bridge with fresh token
    BridgeStatusService.getInstance().restart();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log('[CodeKey] pair error:', msg);
    vscode.window.showErrorMessage(`CodeKey Pair error: ${msg}`);
  } finally {
    clearTimeout(closeTimer);
    channel?.dispose();
  }
}
