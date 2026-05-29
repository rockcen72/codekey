import { RelayClient, ApprovalBridge, startBridgeServer } from '@codekey/shared/bridge';

const PARENT_CHECK_MS = 3000;

/** Check if parent process is still alive. Returns false if orphaned. */
function isParentAlive(): boolean {
  try {
    const ppid = process.ppid;
    if (!ppid || ppid <= 0) return false;
    process.kill(ppid, 0);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : '';
  };

  const deviceId = flag('--device-id');
  const relayUrl = process.env.CODEKEY_RELAY_URL || 'http://localhost:3000';
  const token = process.env.CODEKEY_DEVICE_TOKEN;

  if (!deviceId || !token) {
    console.error('Usage: bridge-entry --device-id <id>');
    console.error('Required env: CODEKEY_DEVICE_TOKEN');
    process.exit(1);
  }

  const relay = new RelayClient(deviceId, token, relayUrl);
  const bridge = new ApprovalBridge(relay);

  bridge.listenRelayCommands();
  const close = await startBridgeServer(bridge, 3001, 'vscode-bundled', () => {
    clearInterval(parentTimer);
    clearInterval(reconcileTimer);
    console.error('[bridge-entry] shutting down via /v1/shutdown');
    bridge.deactivateAll().finally(() => {
      close();
      relay.close();
      process.exit(0);
    });
  });
  console.error('[bridge-entry] HTTP server listening on port 3001');

  // Periodic reconcile: sync in-memory attached-session state with the relay
  // every 60s. This handles cases where a detach from the mini program updates
  // the DB but the session_deactivated WS broadcast doesn't reach the bridge.
  const RECONCILE_MS = 60_000;
  const reconcileTimer = setInterval(() => {
    bridge.reconcileAttachedSessions().catch(() => {
      console.error('[bridge-entry] periodic reconcileAttachedSessions failed');
    });
  }, RECONCILE_MS);

  relay.on('connected', () => {
    console.error('[bridge-entry] connected to relay');
    bridge.reconcileAttachedSessions().catch(() => {
      console.error('[bridge-entry] reconcileAttachedSessions failed');
    });
  });
  try {
    relay.connect();
  } catch (err) {
    console.error('[bridge-entry] relay connect failed:', err);
  }

  // Monitor parent process (VS Code). When it exits, deactivate all sessions and clean up.
  const parentTimer = setInterval(() => {
    if (!isParentAlive()) {
      clearInterval(parentTimer);
      clearInterval(reconcileTimer);
      console.error('[bridge-entry] parent process exited, deactivating sessions');
      bridge.deactivateAll().finally(() => {
        close();
        relay.close();
        process.exit(0);
      });
    }
  }, PARENT_CHECK_MS);

  process.on('SIGINT', () => { clearInterval(parentTimer); clearInterval(reconcileTimer); close(); relay.close(); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(parentTimer); clearInterval(reconcileTimer); close(); relay.close(); process.exit(0); });
}

main().catch((err) => {
  console.error('[bridge-entry] fatal:', err);
  process.exit(1);
});
