import * as vscode from 'vscode';
import * as crypto from 'node:crypto';
import * as os from 'node:os';
import qrcode from 'qrcode-terminal';
import { loadCredentials, saveCredentials, clearCredentials, loadDesktopInstallId, type Credentials } from '../auth/credentials.js';
import { generateEcdhKeyPair, computeSharedSecret, deriveKeyMaterial } from '@codekey/shared/bridge';
import { installHook } from '../hook/installer.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import type { StatusBar } from '../status/bar.js';
import { log } from '../log.js';
import { secureFetch } from '../util/secure-fetch.js';

export async function pairDevice(_context: vscode.ExtensionContext, statusBar: StatusBar): Promise<void> {
  let channel: vscode.OutputChannel | undefined;
  let closeTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    // 1. Load existing credentials. We mutate a working copy in memory and
    //    only saveCredentials() once pairing actually completes — same
    //    invariant the sidebar path enforces (see _pendingPairing in
    //    sidebar-provider.ts). Writing pre-completion would silently strip
    //    deviceToken/contentKeyHex/keyId mid-flight, breaking any phone
    //    currently using the existing binding.
    const existing = loadCredentials();
    let workingDeviceId = existing?.deviceId ?? crypto.randomUUID();
    let workingDeviceSecret = existing?.deviceSecret ?? crypto.randomBytes(32).toString('base64');
    const relayUrl = existing?.relayUrl ?? 'https://codekey.tinymoney.cn';

    const desktopInstallId = loadDesktopInstallId();
    let deviceSecretHash = crypto.createHash('sha256').update(workingDeviceSecret).digest('hex');
    const hostname = os.hostname();

    // 2. Generate ECDH keypair for E2E encryption
    const ecdhKeyPair = generateEcdhKeyPair();

    // 3. Request pairing code from relay, sending our public key
    const body: Record<string, unknown> = { desktopInstallId, deviceSecretHash, deviceName: hostname, publicKeyHex: ecdhKeyPair.publicKeyHex };
    if (existing?.deviceId) body.deviceId = existing.deviceId;

    let response = await secureFetch(`${relayUrl}/api/v1/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    let usedFreshDevice = false;
    if ((response.status === 403 || response.status === 404) && existing?.deviceId) {
      // Server rejected our deviceId — old binding is gone server-side.
      // The old deviceToken is dead too, so wiping disk creds is correct
      // here (matches sidebar fresh-device branch).
      clearCredentials();
      workingDeviceId = crypto.randomUUID();
      workingDeviceSecret = crypto.randomBytes(32).toString('base64');
      deviceSecretHash = crypto.createHash('sha256').update(workingDeviceSecret).digest('hex');
      response = await secureFetch(`${relayUrl}/api/v1/devices/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ desktopInstallId, deviceSecretHash, deviceName: hostname, publicKeyHex: ecdhKeyPair.publicKeyHex }),
      });
      usedFreshDevice = true;
    }

    if (!response.ok) {
      throw new Error(`Pairing request failed: ${await response.text()}`);
    }

    const pairResult = await response.json() as { code: string; deviceId?: string };
    const effectiveDeviceId = pairResult.deviceId ?? workingDeviceId;

    // 4. Reuse existing legacy E2E content key when re-pairing the same install
    //    so phones that already cached this key remain in sync. Generate a
    //    new key only on truly first-time or fresh-device pairings — matches
    //    the sidebar provider's reuse policy. Same justification: a fresh
    //    randomBytes() invalidates whatever the phone has stored.
    let contentKeyHex: string;
    let keyId: string;
    if (!usedFreshDevice && existing?.contentKeyHex && existing?.keyId) {
      contentKeyHex = existing.contentKeyHex;
      keyId = existing.keyId;
    } else {
      contentKeyHex = crypto.randomBytes(32).toString('hex');
      keyId = contentKeyHex.slice(0, 16);
    }

    // 5. Show pairing code + E2E key QR to user
    channel = vscode.window.createOutputChannel('CodeKey Pair');
    channel.appendLine('');
    channel.appendLine('┌────────────────────────────────────────────┐');
    channel.appendLine(`│  Pairing Code: ${pairResult.code.padEnd(30)}│`);
    channel.appendLine('│                                            │');
    channel.appendLine('│  Scan QR below with WeChat Mini Program    │');
    channel.appendLine('│  or enter pairing code manually            │');
    channel.appendLine('│  Code expires in 5 minutes                 │');
    channel.appendLine('└────────────────────────────────────────────┘');
    channel.appendLine('');

    // Render ASCII QR with contentKey embedded (codekey:// custom scheme).
    // The QR is unicode block art — the URL text containing the contentKey
    // is NOT printed to the channel, only the visual QR. Phones must scan
    // the QR to obtain the key. Manual-entry path was removed (plan §8 prod
    // blocker — never print contentKey in plaintext to OutputChannel).
    qrcode.generate(
      `codekey://pair?code=${pairResult.code}&key_id=${keyId}&content_key=${contentKeyHex}&v=1`,
      { small: true },
      (qr: string) => {
        channel!.appendLine(qr);
      },
    );

    channel.appendLine('');
    channel.appendLine(`Key ID: ${keyId}`);
    channel.appendLine('Scan the QR above to bind. Manual key entry is no longer supported —');
    channel.appendLine('use the QR code from the sidebar for Telegram (ECDH) or WeChat (embedded key).');
    channel.appendLine('');
    channel.show();

    // Schedule auto-close after 120s — long enough to scan QR but
    // not so long that CC picks it up as an @-mention source.
    closeTimer = setTimeout(() => channel?.dispose(), 120_000);

    vscode.window.showInformationMessage(
      `Pairing code: ${pairResult.code}. ${keyId ? 'E2E encryption key ready.' : ''}`,
    );

    // 6. Connect to relay WS and wait for device_token
    // Uses native WebSocket (Node.js 18+) — no 'ws' package dependency needed.
    const wsUrl = relayUrl.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/ws?device_id=${effectiveDeviceId}&device_secret=${workingDeviceSecret}`);

    channel.appendLine('Waiting for phone to scan QR code...');

    const tokenResult = await new Promise<{ deviceToken: string; phonePublicKeyHex?: string; e2eAvailable?: boolean; platform?: string; e2eKeyReceived?: boolean }>((resolve, reject) => {
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
            resolve({ deviceToken: msg.payload.deviceToken, phonePublicKeyHex: msg.payload.phonePublicKeyHex, e2eAvailable: msg.payload.e2eAvailable, platform: msg.payload.platform, e2eKeyReceived: msg.payload.e2eKeyReceived });
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

    // 7. If phone supports ECDH, compute shared secret and derive E2E key material.
    //    On success, overwrite the legacy QR key — ECDH-derived key becomes the active one.
    let ecdhMaterial: { contentKeyHex: string; keyId: string } | undefined;
    if (tokenResult.phonePublicKeyHex) {
      try {
        const sharedSecret = computeSharedSecret(ecdhKeyPair.privateKey, tokenResult.phonePublicKeyHex);
        ecdhMaterial = deriveKeyMaterial(sharedSecret);
      } catch (err) {
        log('[CodeKey] ECDH key exchange failed:', err instanceof Error ? err.message : String(err));
      }
    }

    // 8. Save deviceToken + E2E keys and notify user.
    // First write to disk: merge whatever's currently on disk (might be the
    // pre-existing binding we deliberately didn't touch) with the freshly
    // negotiated state.
    const onDisk = loadCredentials();
    const final: Credentials = {
      ...(onDisk ?? {}),
      deviceId: effectiveDeviceId,
      deviceSecret: workingDeviceSecret,
      relayUrl,
      deviceToken: tokenResult.deviceToken,
    };
    if (tokenResult.platform === 'feishu' || tokenResult.platform === 'wechat' || tokenResult.platform === 'telegram') {
      final.platform = tokenResult.platform;
    }
    if (ecdhMaterial) {
      // ECDH success — this is the active key used for all subsequent crypto
      final.contentKeyHex = ecdhMaterial.contentKeyHex;
      final.keyId = ecdhMaterial.keyId;
    } else if (tokenResult.e2eKeyReceived) {
      // Phone explicitly confirmed it received the legacy key (QR Phase 1).
      // Desktop saves the same key so matching works — this keeps old
      // Telegram Mini Apps that scanned a `ck_` QR compatible.
      final.contentKeyHex = contentKeyHex;
      final.keyId = keyId;
    } else if (tokenResult.platform === 'telegram' && tokenResult.e2eAvailable) {
      // Telegram ECDH attempted but phone didn't confirm key receipt.
      // Delete to avoid false E2E state.
      delete final.contentKeyHex;
      delete final.keyId;
    } else {
      // WeChat/Feishu/old server: phone got the legacy key embedded in the
      // QR code data, or server is pre-ECDH. Desktop saves the same key.
      final.contentKeyHex = contentKeyHex;
      final.keyId = keyId;
    }
    saveCredentials(final);

    clearTimeout(closeTimer);
    channel.appendLine('✓ Binding successful! Device connected.');
    channel.dispose();
    vscode.window.showInformationMessage('CodeKey paired successfully!');

    // Install/refresh Claude hooks immediately after pairing; activate() may
    // have skipped this earlier because no device token existed yet.
    const scriptsDir = vscode.Uri.joinPath(_context.extensionUri, 'scripts').fsPath;
    installHook(scriptsDir);

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
