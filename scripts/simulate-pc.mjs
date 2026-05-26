// CodeKey PC-side simulation — pairs, registers session, sends events, waits for approval
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const RELAY = process.env.RELAY || 'http://127.0.0.1:3000';

// 1. Create device credentials
const deviceSecret = randomBytes(32).toString('hex');
const deviceSecretHash = createHash('sha256').update(deviceSecret).digest('hex');

console.log('=== CodeKey PC Simulator ===\n');

// 2. Pair with server
const pairRes = await fetch(`${RELAY}/api/v1/devices/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceSecretHash, deviceName: 'simulated-pc' }),
});
if (!pairRes.ok) { console.error('Pair failed:', await pairRes.text()); process.exit(1); }
const pair = await pairRes.json();
console.log(`Pairing code: ${pair.code}`);
console.log(`Device ID: ${pair.deviceId}`);
console.log('Enter this code in the WeChat Mini Program.\n');

// 3. Open pairing WS to receive device_token
const wsUrl = RELAY.replace(/^http/, 'ws');
const pairingWs = new WebSocket(`${wsUrl}/ws?device_id=${pair.deviceId}&device_secret=${deviceSecret}`);

const deviceToken = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout waiting for device_token (60s)')), 60000);
  pairingWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'pairing_ready') {
      console.log('Waiting for Mini Program to confirm...');
    }
    if (msg.type === 'device_token') {
      clearTimeout(timeout);
      console.log('✓ Device confirmed!');
      resolve(msg.payload.deviceToken);
    }
  });
  pairingWs.on('error', reject);
});
pairingWs.close();

// 4. Open runtime WS and register session
const pcWs = new WebSocket(`${wsUrl}/ws?device_id=${pair.deviceId}&token=${deviceToken}`);
const sessionId = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout waiting for session_registered')), 10000);
  pcWs.on('open', () => {
    pcWs.send(JSON.stringify({ type: 'register_session', payload: { agentType: 'claude-code' } }));
  });
  pcWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'session_registered') {
      clearTimeout(timeout);
      console.log(`✓ Session registered: ${msg.payload.sessionId}`);
      resolve(msg.payload.sessionId);
    }
  });
  pcWs.on('error', reject);
});

console.log('\nSending approval_required event...\n');

// 5. Send an approval_required event
pcWs.send(JSON.stringify({
  type: 'event',
  payload: {
    clientEventId: 'sim-evt-1',
    sessionId,
    agent: 'claude-code',
    eventType: 'approval_required',
    data: {
      type: 'approval_required',
      command: 'rm -rf node_modules && npm install',
      risk: 'medium',
      summary: 'Reinstall all dependencies',
      cwd: '/home/user/project',
    },
    ts: new Date().toISOString(),
  },
}));

// 6. Wait for event_ack
const eventAck = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout waiting for event_ack')), 10000);
  pcWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'event_ack') {
      clearTimeout(timeout);
      console.log(`✓ Event sent (ID: ${msg.payload.serverEventId})`);
      resolve(msg.payload);
    }
  });
  pcWs.on('error', reject);
});

console.log('\nWaiting for approval from Mini Program...\n');

// 7. Wait for approval_forward
await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout waiting for approval (60s)')), 60000);
  pcWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'approval_forward') {
      clearTimeout(timeout);
      console.log(`✓ Decision received: ${msg.payload.decision}`);
      if (msg.payload.message) console.log(`  Message: ${msg.payload.message}`);
      resolve(msg.payload);
    }
  });
  pcWs.on('error', reject);
});

console.log('\n=== Test complete ===');
pcWs.close();
process.exit(0);
