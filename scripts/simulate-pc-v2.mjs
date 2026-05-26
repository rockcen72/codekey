// CodeKey PC Simulator v2 — long wait, proper flow
import { createHash, randomBytes } from 'node:crypto';
import WebSocket from 'ws';

const RELAY = process.env.RELAY || 'http://127.0.0.1:3000';
const wsUrl = RELAY.replace(/^http/, 'ws');

// 1. Create device credentials
const deviceSecret = randomBytes(32).toString('hex');
const deviceSecretHash = createHash('sha256').update(deviceSecret).digest('hex');

console.log('=== CodeKey PC Simulator v2 ===\n');

// 2. Pair with server
const pairRes = await fetch(`${RELAY}/api/v1/devices/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ deviceSecretHash, deviceName: 'codekey-pc' }),
});
if (!pairRes.ok) { console.error('Pair failed:', await pairRes.text()); process.exit(1); }
const pair = await pairRes.json();
console.log(`Pairing code: ${pair.code}`);
console.log(`Device ID: ${pair.deviceId}`);
console.log('Enter this code in the WeChat Mini Program.\n');

// 3. Open pairing WS — waits up to 5 minutes for Mini Program confirmation
const pairingWs = new WebSocket(`${wsUrl}/ws?device_id=${pair.deviceId}&device_secret=${deviceSecret}`);

const deviceToken = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout waiting for device_token (5min)')), 300000);
  pairingWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'device_token') {
      clearTimeout(timeout);
      console.log('✓ Device confirmed!');
      resolve(msg.payload.deviceToken);
    }
  });
  pairingWs.on('error', reject);
});
pairingWs.close();

// 4. Open runtime WS, register session, send event
const pcWs = new WebSocket(`${wsUrl}/ws?device_id=${pair.deviceId}&token=${deviceToken}`);
const sessionId = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout waiting for session')), 10000);
  pcWs.on('open', () => {
    pcWs.send(JSON.stringify({
      type: 'register_session',
      payload: { agentType: 'claude-code' },
    }));
  });
  pcWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'session_registered') {
      clearTimeout(timeout);
      console.log('✓ Session registered:', msg.payload.sessionId);
      resolve(msg.payload.sessionId);
    }
  });
});

console.log('\nSending approval_required event...\n');

pcWs.send(JSON.stringify({
  type: 'event',
  payload: {
    eventType: 'approval_required',
    data: {
      command: 'rm -rf node_modules && npm install',
      summary: 'Reinstall all dependencies',
      cwd: '/home/project',
      risk: 'medium',
    },
  },
}));

// Wait for event ack
await new Promise((resolve) => {
  pcWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'event_ack') {
      console.log('✓ Event sent (ID:', msg.payload.serverEventId, ')');
      resolve(null);
    }
  });
});

console.log('\nWaiting for approval from Mini Program...\n');

// Wait for approval decision
const decision = await new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error('Timeout waiting for approval (120s)')), 120000);
  pcWs.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.type === 'approval_forward') {
      clearTimeout(timeout);
      console.log(`✓ Decision received: ${msg.payload.decision}`);
      if (msg.payload.message) console.log(`  Message: ${msg.payload.message}`);
      resolve(msg.payload.decision);
    }
  });
});

console.log('\n=== Test complete ===');
pcWs.close();
process.exit(0);
