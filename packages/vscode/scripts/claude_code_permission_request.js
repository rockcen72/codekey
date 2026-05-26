#!/usr/bin/env node
// CodeKey PermissionRequest hook for Claude Code
// Forwards Bash tool permission requests to the CodeKey bridge for phone approval.
const BRIDGE_URL = 'http://127.0.0.1:3001';
const TIMEOUT_MS = 120_000;
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  try {
    const event = JSON.parse(input);
    // Only intercept Bash tool permission requests
    if (event.tool_name !== 'Bash') process.exit(0);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const res = await fetch(BRIDGE_URL + '/v1/hook/approval', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: input,
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) process.exit(0);
    const result = await res.json();
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
  } catch {
    // Bridge unavailable or error — fall through to Claude default prompt
    process.exit(0);
  }
});
