#!/usr/bin/env node
// Claude Code Stop hook → task_complete event
// Sends both full summary and a condensed phone version.
// claudeSessionId sent for logging/correlation only; not forwarded to relay.

var SUMMARY_MAX_LEN = 4000;    // cap full summary — sidebar / web UI
var SUMMARY_SHORT_MAX = 200;   // cap phone summary — mini program display

function truncateForPhone(text, maxLen) {
  if (text.length <= maxLen) return text;
  var t = text.slice(0, maxLen);
  // Try sentence boundary first (ASCII punctuation only)
  var sentEnd = Math.max(
    t.lastIndexOf('.'), t.lastIndexOf('!'),
    t.lastIndexOf('?'), t.lastIndexOf('\n'),
  );
  if (sentEnd > maxLen * 0.4) return t.slice(0, sentEnd + 1);
  // Fallback: word boundary
  var space = t.lastIndexOf(' ');
  if (space > maxLen * 0.4) return t.slice(0, space);
  return t.slice(0, maxLen - 1) + '...';
}

let body = '';
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  try {
    const event = JSON.parse(body);
    const claudeSessionId = event.sessionId || event.session_id || '';
    const codekeyWindowId = process.env.CODEKEY_WINDOW_ID || '';
    const lastMsg = event.last_assistant_message || '';
    const summary = typeof lastMsg === 'string'
      ? lastMsg.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, SUMMARY_MAX_LEN)
      : '';

    fetch('http://127.0.0.1:3001/v1/hook-event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventType: 'task_complete',
        claudeSessionId,
        codekeyWindowId,
        debugEnvWindowId: process.env.CODEKEY_WINDOW_ID || '(unset)',
        data: {
          type: 'task_complete',
          summary,
          summaryShort: truncateForPhone(summary, SUMMARY_SHORT_MAX),
        },
      }),
    }).catch(() => { /* bridge may not be running */ });
  } catch { /* ignore parse errors */ }
});
