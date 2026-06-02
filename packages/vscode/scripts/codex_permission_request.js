#!/usr/bin/env node
// CodeKey PermissionRequest hook for Codex
// Forwards permission requests to the CodeKey bridge for phone approval.
const BRIDGE_URL = process.env.CODEKEY_BRIDGE_URL || 'http://127.0.0.1:3001';
const TIMEOUT_MS = 300_000;
const DIAG_LOG = require('path').join(require('os').homedir(), '.codex', 'codekey-hook.log');
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

    if (!input.trim() || !event || event.hook_event_name !== 'PermissionRequest') {
      diag('skip: unexpected event type or empty input');
      process.exit(0);
    }

    const ctrl = new AbortController();
    const timer = setTimeout(function () { diag('TIMEOUT reached ' + TIMEOUT_MS + 'ms'); ctrl.abort(); }, TIMEOUT_MS);
    const body = JSON.stringify({
      session_id: event.session_id,
      cwd: event.cwd,
      tool_name: event.tool_name,
      tool_input: event.tool_input,
      hook_event_name: event.hook_event_name,
      permission_mode: event.permission_mode,
      turn_id: event.turn_id,
      transcript_path: event.transcript_path,
    });
    diag('POSTing to bridge, body length: ' + body.length);
    var res;
    try {
      res = await fetch(BRIDGE_URL + '/v1/codex-hooks/permission-request', {
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
    var dec = result.hookSpecificOutput?.decision || result.decision || {};
    diag('bridge decision behavior=' + dec.behavior + ' msg=' + (dec.message || ''));
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: dec.behavior || 'deny', message: dec.message || 'Denied by CodeKey' },
      },
    }));
  } catch (err) {
    diag('hook error: ' + (err?.message ?? err));
    process.exit(0);
  }
});
