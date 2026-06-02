import { RelayClient, ApprovalBridge, startBridgeServer, CodexResumeManager, OpenCodeSessionManager } from '@codekey/shared/bridge';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const PARENT_CHECK_MS = 3000;

/** Load deviceSecret from credentials file (~/.codekey/credentials.json) for pairing. */
function loadDeviceSecret(): string | undefined {
  try {
    const credPath = path.join(os.homedir(), '.codekey', 'credentials.json');
    const raw = fs.readFileSync(credPath, 'utf-8');
    const creds = JSON.parse(raw);
    return creds.deviceSecret ?? undefined;
  } catch {
    return undefined;
  }
}

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
  const startedAt = Date.now();
  const args = process.argv.slice(2);
  const flag = (name: string): string => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : '';
  };

  const deviceId = flag('--device-id');
  const relayUrl = process.env.CODEKEY_RELAY_URL || 'https://81.70.235.58';
  const token = process.env.CODEKEY_DEVICE_TOKEN;

  if (!deviceId || !token) {
    console.error('Usage: bridge-entry --device-id <id>');
    console.error('Required env: CODEKEY_DEVICE_TOKEN');
    process.exit(1);
  }

  const isPairing = args.includes('--pairing');
  const relay = new RelayClient(deviceId, token, relayUrl, isPairing);
  const bridge = new ApprovalBridge(relay);

  bridge.listenRelayCommands();

  // ── Codex Resume Manager ──────────────────────────────────
  const resumedServerSessionIds = new Set<string>();
  bridge.registerResumedServerSessionIds(resumedServerSessionIds);
  const resumeStoragePath = path.join(os.tmpdir(), 'codekey-resume-sessions.json');
  const codexResumeManager = new CodexResumeManager(relay, resumedServerSessionIds, bridge, resumeStoragePath);
  codexResumeManager.startListening();

  // ── OpenCode Session Manager ─────────────────────────────
  let opencodeManager: OpenCodeSessionManager | null = null;
  try {
    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
    cp.execSync(`${whichCmd} opencode`, { stdio: 'ignore', timeout: 3000 });
    opencodeManager = new OpenCodeSessionManager('http://127.0.0.1:4096', bridge);
    opencodeManager.start().catch((err: Error) => {
      console.error('[bridge-entry] OpenCode SSE connect failed:', err);
    });
    console.error('[bridge-entry] OpenCode integration started');
  } catch {
    console.error('[bridge-entry] opencode CLI not found, skipping OpenCode integration');
  }

  // Admin panel dir: resolved relative to the bundled bridge-entry.js in extension dist
  const adminDir = __dirname;

  const shutdownCb = () => {
    clearInterval(parentTimer);
    clearInterval(reconcileTimer);
    clearInterval(pruneTimer);
    console.error('[bridge-entry] shutting down via /v1/shutdown');
    const tasks = [];
    if (opencodeManager) { opencodeManager.stop(); }
    tasks.push(bridge.deactivateAll());
    tasks.push(codexResumeManager.stopAll());
    Promise.allSettled(tasks).finally(() => {
      close();
      relay.close();
      process.exit(0);
    });
  };

  const { close, port } = await startBridgeServer(bridge, 3001, 'vscode-bundled', shutdownCb, startedAt, { deviceId, relayUrl, deviceToken: token, deviceSecret: loadDeviceSecret(), adminDir }, codexResumeManager);
  console.error(`[bridge-entry] HTTP server listening on port ${port}`);

  // Periodic reconcile: sync in-memory attached-session state with the relay
  // every 60s. This handles cases where a detach from the mini program updates
  // the DB but the session_deactivated WS broadcast doesn't reach the bridge.
  const RECONCILE_MS = 60_000;
  const reconcileTimer = setInterval(() => {
    bridge.reconcileAttachedSessions().catch(() => {
      console.error('[bridge-entry] periodic reconcileAttachedSessions failed');
    });
  }, RECONCILE_MS);

  // Periodic prune: clean up finished transcript-attached sessions on the relay
  // that are no longer in the sidebar keep list. Runs every 5 minutes.
  const PRUNE_MS = 300_000;
  const pruneTimer = setInterval(() => {
    bridge.pruneSessions();
  }, PRUNE_MS);

  relay.on('connected', () => {
    console.error('[bridge-entry] connected to relay');
    bridge.reconcileAttachedSessions().finally(() => {
      // Prune right after first reconcile so old sessions get cleaned up immediately
      bridge.pruneSessions();
    }).catch(() => {
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
      clearInterval(pruneTimer);
      console.error('[bridge-entry] parent process exited, deactivating sessions');
      bridge.deactivateAll().finally(() => {
        close();
        relay.close();
        process.exit(0);
      });
    }
  }, PARENT_CHECK_MS);

  process.on('SIGINT', () => { clearInterval(parentTimer); clearInterval(reconcileTimer); clearInterval(pruneTimer); close(); relay.close(); process.exit(0); });
  process.on('SIGTERM', () => { clearInterval(parentTimer); clearInterval(reconcileTimer); clearInterval(pruneTimer); close(); relay.close(); process.exit(0); });
}

main().catch((err) => {
  console.error('[bridge-entry] fatal:', err);
  process.exit(1);
});
