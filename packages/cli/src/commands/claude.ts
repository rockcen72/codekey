import { randomUUID } from 'node:crypto';
import { Command } from 'commander';
import { RelayClient } from '../daemon/relay-client.js';
import { SessionManager } from '../daemon/session-manager.js';
import { DeviceSecretManager } from '../auth/device-secret.js';
import { ClaudeCodeAdapter, ResponseMapper } from '@devtap/adapters';
import { PtyWrapper } from '../terminal/pty-wrapper.js';

export const claudeCommand = new Command('claude')
  .description('Start a Claude Code session with remote control')
  .argument('[args...]', 'Arguments to pass to Claude Code')
  .option('--daemon', 'Run in background daemon mode')
  .option('--relay <url>', 'Relay server URL', 'http://localhost:3000')
  .action(async (args: string[], options: { daemon?: boolean; relay?: string }) => {
    const secretManager = new DeviceSecretManager();
    const { deviceId } = secretManager.loadOrCreate();
    const deviceToken = secretManager.getDeviceToken();
    if (!deviceToken) {
      console.error('Not paired. Run `devtap login` first.');
      process.exit(1);
    }

    const sessionManager = new SessionManager();
    const adapter = new ClaudeCodeAdapter({ cwd: process.cwd() });
    const pty = new PtyWrapper();
    const mapper = new ResponseMapper();
    const relay = new RelayClient(deviceId, deviceToken, options.relay);

    const localSession = sessionManager.create('claude-code');
    let serverSessionId: string = localSession.id;
    const agentArgs = args.length > 0 ? args : ['-p', 'What would you like to work on?'];

    // Connect relay and wait for WS to be open before sending registration
    relay.connect();
    await relay.waitForConnection();

    // Register session with server via WS (creates sessions row for FK constraint)
    serverSessionId = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Session registration timeout')), 10000);
      relay.once('session_registered', (payload: { sessionId: string }) => {
        clearTimeout(timer);
        resolve(payload.sessionId);
      });
      relay.sendRaw(JSON.stringify({
        type: 'register_session',
        payload: { agentType: 'claude-code' },
      }));
    });

    // Track clientEventId → event type mapping for correct mapper.setPending type
    const pendingEventTypes = new Map<string, string>();

    // Wire adapter → relay
    adapter.on('agent_event', (event) => {
      const clientEventId = randomUUID();
      const eventType = 'type' in event ? event.type : undefined;
      const needsPending = eventType === 'approval_required' || eventType === 'question';

      if (needsPending && eventType) {
        pendingEventTypes.set(clientEventId, eventType);
      }

      relay.sendEvent(serverSessionId, {
        type: 'event' as const,
        payload: {
          clientEventId: needsPending ? clientEventId : undefined,
          sessionId: serverSessionId,
          agent: 'claude-code',
          eventType: eventType ?? 'unknown',
          data: event,
          ts: new Date().toISOString(),
        },
      });
    });

    // Wire relay → event_ack → mapper.setPending
    relay.on('event_ack', (ack: { clientEventId?: string; serverEventId: string }) => {
      const pendingType = (ack.clientEventId && pendingEventTypes.get(ack.clientEventId)) ?? 'approval';
      if (ack.clientEventId) pendingEventTypes.delete(ack.clientEventId);
      mapper.setPending(ack.serverEventId, pendingType as 'approval' | 'question');
    });

    // Wire relay → approval_forward → response mapper → PTY
    relay.on('approval_forward', (payload) => {
      const stdin = mapper.map(payload.eventId, payload.decision, payload.message);
      if (stdin) {
        pty.write(stdin);
        adapter.onResponseSent();
      }
    });

    // Wire PTY → adapter
    pty.on('data', (chunk: string) => adapter.processChunk(chunk));
    pty.on('exit', (code: number) => adapter.processExit(code));

    // Spawn Claude Code
    pty.spawn({
      command: 'npx',
      args: ['@anthropic-ai/claude-code', ...agentArgs],
      cwd: process.cwd(),
    });
  });
