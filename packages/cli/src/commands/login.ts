import { Command } from 'commander';
import WebSocket from 'ws';
import { DeviceSecretManager } from '../auth/device-secret.js';
import { renderQrCode } from '../qrcode/display.js';

export const loginCommand = new Command('login')
  .description('Display QR code to bind with WeChat mini program')
  .option('--relay <url>', 'Relay server URL', 'http://localhost:3000')
  .action(async (options: { relay: string }) => {
    const secretManager = new DeviceSecretManager();
    const { deviceId, deviceSecret, isNew } = secretManager.loadOrCreate();
    const deviceSecretHash = secretManager.hashSecret(deviceSecret);
    const hostname = (await import('node:os')).hostname();

    // 1. Request pairing code from relay
    // First pairing (isNew): don't send deviceId, server creates new device.
    // Re-pair: send deviceId so server locates existing device record.
    const body: Record<string, unknown> = { deviceSecretHash, deviceName: hostname };
    if (!isNew) body.deviceId = deviceId;
    const response = await fetch(`${options.relay}/api/v1/devices/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.error('Failed to start pairing:', await response.text());
      process.exit(1);
    }

    const pairResult = await response.json() as { code: string; deviceId?: string };
    const code = pairResult.code;
    const serverDeviceId = pairResult.deviceId;
    const effectiveDeviceId = serverDeviceId ?? deviceId;

    // On first pairing, save the server-assigned deviceId for future connections
    if (isNew && serverDeviceId) {
      secretManager.saveDeviceId(serverDeviceId);
    }

    // Render QR with pairing code
    console.log('\nScan this QR code with WeChat Mini Program:\n');
    renderQrCode(code);
    console.log(`\nOr enter code manually: ${code}`);
    console.log('Code expires in 5 minutes.\n');

    // 2. Establish pairing WS (authenticated by device_secret)
    //    Waits for device_token to be pushed after mini program confirms
    const wsUrl = options.relay.replace(/^http/, 'ws');
    const ws = new WebSocket(`${wsUrl}/ws?device_id=${effectiveDeviceId}&device_secret=${deviceSecret}`);

    ws.on('message', (raw: Buffer) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'device_token') {
        secretManager.saveDeviceToken(msg.payload.deviceToken);
        console.log('\n✓ Binding successful! Device connected.\n');
        ws.close();
      }
      if (msg.type === 'pairing_ready') {
        console.log('Waiting for QR code scan...');
      }
    });

    ws.on('error', (err) => {
      console.error('Pairing connection failed:', err.message);
      process.exit(1);
    });
  });
