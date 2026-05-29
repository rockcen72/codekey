#!/usr/bin/env node
// CodeKey PermissionRequest hook for Claude Code
// Forwards Bash tool permission requests to the CodeKey bridge for phone approval.
const BRIDGE_URL = 'http://127.0.0.1:3001';
const TIMEOUT_MS = 120_000;
const DIAG_LOG = require('path').join(require('os').homedir(), '.claude', 'codekey-permission-diagnostic.log');
const fs = require('fs');
function diag(msg) {
  try { fs.appendFileSync(DIAG_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}

diag('hook started, BRIDGE_URL=' + BRIDGE_URL + ' args=' + process.argv.join(' '));
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  diag('stdin end, total input len=' + input.length);
  diag('input preview: ' + input.slice(0, 500));
  try {
    const event = JSON.parse(input);
    diag('event keys: ' + Object.keys(event).join(', '));

    // Try ALL plausible session ID field names
    var sid = event.session_id || event.sessionId || event.claudeSessionId || event.claude_session_id || '';
    if (!sid && event.metadata) {
      sid = event.metadata.sessionId || event.metadata.session_id || event.metadata.claudeSessionId || '';
    }
    // Last resort: try any field whose name contains "session"
    if (!sid) {
      for (var key of Object.keys(event)) {
        if (key.toLowerCase().indexOf('session') !== -1 && typeof event[key] === 'string') {
          sid = event[key];
          diag('found session ID via fallback key=' + key + ' value=' + sid);
          break;
        }
      }
    }

    diag('resolved claudeSessionId=' + sid);
    const codekeyWindowId = process.env.CODEKEY_WINDOW_ID || '';
    diag('codekeyWindowId=' + codekeyWindowId + ' CODEKEY_WINDOW_ID=' + (process.env.CODEKEY_WINDOW_ID || '(unset)'));

    const ctrl = new AbortController();
    const timer = setTimeout(function () { diag('TIMEOUT reached ' + TIMEOUT_MS + 'ms'); ctrl.abort(); }, TIMEOUT_MS);
    const body = JSON.stringify({ claudeSessionId: sid, codekeyWindowId: codekeyWindowId, source: 'permission_request', debugEnvWindowId: process.env.CODEKEY_WINDOW_ID || '(unset)', rawEvent: event });
    diag('POSTing to bridge, body length: ' + body.length);
    var res;
    try {
      res = await fetch(BRIDGE_URL + '/v1/hook/approval', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      });
    } catch (fetchErr) {
      diag('fetch failed: ' + (fetchErr.message || fetchErr));
      process.exit(0);
    }
    clearTimeout(timer);
    diag('bridge response: status=' + res.status + ' ' + res.statusText);
    if (!res.ok) { diag('bridge returned non-OK, exiting 0'); process.exit(0); }
    var result = await res.json();
    diag('bridge result: approved=' + result.approved);
    if (result.approved) {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      }));
    } else {
      console.log(JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message: 'Denied by CodeKey' },
        },
      }));
    }
  } catch (err) {
    diag('hook error: ' + (err?.message ?? err));
    process.exit(0);
  }
});
