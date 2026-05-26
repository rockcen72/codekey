import { Command } from 'commander';
import { RelayClient } from '../daemon/relay-client.js';
import { ApprovalBridge } from '../bridge/handler.js';
import { startBridgeServer } from '../bridge/server.js';
import { DeviceSecretManager } from '../auth/device-secret.js';

export const bridgeCommand = new Command('bridge')
  .description('Start the local bridge HTTP server for Claude Code hook events')
  .option('--relay <url>', 'Relay server URL', 'http://localhost:3000')
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

    // Register a hook session with the relay
    relay.sendRaw(JSON.stringify({
      type: 'register_session',
      payload: { agentType: 'claude-code-hook' },
    }));

    bridge.serverSessionId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Session registration timeout')), 10_000);
      relay.once('session_registered', (payload: { sessionId: string }) => {
        clearTimeout(timer);
        resolve(payload.sessionId);
      });
    });

    bridge.listenRelayCommands();
    const close = await startBridgeServer(bridge);

    console.error(`bridge running — session ${bridge.serverSessionId}`);

    // Keep alive until signal
    process.on('SIGINT', () => { close(); relay.close(); process.exit(0); });
    process.on('SIGTERM', () => { close(); relay.close(); process.exit(0); });
  });
