#!/usr/bin/env node
// Claude Code Notification(idle_prompt) hook → session_idle event
// claudeSessionId sent for logging/correlation only; not forwarded to relay.

let body = '';
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(body);
    const claudeSessionId = event.sessionId || event.session_id || '';
    const codekeyWindowId = process.env.CODEKEY_WINDOW_ID || '';

    fetch('http://127.0.0.1:3001/v1/hook-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'session_idle',
        claudeSessionId,
        codekeyWindowId,
        debugEnvWindowId: process.env.CODEKEY_WINDOW_ID || '(unset)',
        data: { type: 'session_idle', idleMinutes: 0 },
      }),
    }).catch(() => { /* bridge may not be running */ });
  } catch { /* ignore parse errors */ }
});
