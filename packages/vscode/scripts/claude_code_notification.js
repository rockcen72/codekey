#!/usr/bin/env node
// Claude Code Notification(idle_prompt) hook → session_idle event + task_complete synthesis
// claudeSessionId sent for logging/correlation only; not forwarded to relay.

var HOOK_SUMMARY_MAX_LEN = 4000;

let body = '';
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(body);
    const claudeSessionId = event.sessionId || event.session_id || '';
    const codekeyWindowId = process.env.CODEKEY_WINDOW_ID || '';
    const lastMsg = event.last_assistant_message || '';
    const summary = typeof lastMsg === 'string'
      ? lastMsg.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, HOOK_SUMMARY_MAX_LEN)
      : '';

    fetch('http://127.0.0.1:3001/v1/hook-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'session_idle',
        claudeSessionId,
        codekeyWindowId,
        lastAssistantMessage: summary,
        debugEnvWindowId: process.env.CODEKEY_WINDOW_ID || '(unset)',
        data: { type: 'session_idle', idleMinutes: 0 },
      }),
    }).catch(() => { /* bridge may not be running */ });
  } catch { /* ignore parse errors */ }
});
