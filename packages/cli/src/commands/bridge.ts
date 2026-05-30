import { Command } from 'commander';
import { RelayClient, ApprovalBridge, startBridgeServer } from '@codekey/shared/bridge';
import { DeviceSecretManager } from '../auth/device-secret.js';

export const bridgeCommand = new Command('bridge')
  .description('Start the local bridge HTTP server for Claude Code hook events')
  .option('--relay <url>', 'Relay server URL', 'https://81.70.235.58')
  .action(async (options: { relay: string }) => {
    const secretManager = new DeviceSecretManager();
    const deviceId = secretManager.getDeviceId();
    const deviceToken = secretManager.getDeviceToken();

    if (!deviceToken) {
      console.error('No device token found. Run `codekey login` first to pair.');
      process.exit(1);
    }

    const relay = new RelayClient(deviceId, deviceToken, options.relay);
    const bridge = new ApprovalBridge(relay);

    relay.connect();
    await relay.waitForConnection();

    console.error('bridge running — waiting for hook events...');

    bridge.listenRelayCommands();
    const { close } = await startBridgeServer(bridge);

    // Keep alive until signal
    process.on('SIGINT', () => { close(); relay.close(); process.exit(0); });
    process.on('SIGTERM', () => { close(); relay.close(); process.exit(0); });
  });
