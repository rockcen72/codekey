#!/usr/bin/env node
/**
 * Codex PermissionRequest hook for CodeKey.
 *
 * Receives a PermissionRequest from Codex via stdin, forwards it to the
 * local CodeKey bridge, waits for phone approval, and returns allow/deny.
 *
 * Env overrides:
 *   CODEKEY_BRIDGE_URL  — bridge base URL (default: http://127.0.0.1:3001)
 *   CODEKEY_HOOK_AUTO_ALLOW=1  — skip bridge, always allow (local debugging)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const logPath = path.join(os.homedir(), '.codekey-codex-hook.log');

function log(msg) {
  try { fs.appendFileSync(logPath, `${new Date().toISOString()} ${msg}\n`); } catch {}
}

function respond(decision) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision,
    },
  }) + '\n');
}

function bypass(reason) {
  log(`BYPASS ${reason}`);
  process.exit(0);
}

// Read stdin (Codex hook event JSON)
let input = '';
try {
  input = fs.readFileSync(0, 'utf8').trim();
} catch (e) {
  log(`STDIN_READ_ERROR: ${e.message}`);
  bypass('stdin_error');
}

if (!input) {
  // Codex sometimes sends no input on first invocation (hooks probe)
  bypass('no_input');
}

let event;
try {
  event = JSON.parse(input);
} catch (err) {
  log(`PARSE_ERROR: ${err.message}`);
  bypass('parse_error');
}

log(`EVENT ${event.hook_event_name} tool=${event.tool_name || ''} session=${event.session_id || ''}`);

if (event.hook_event_name !== 'PermissionRequest') {
  log(`UNEXPECTED_EVENT ${event.hook_event_name} — ignoring`);
  process.exit(0);
}

// Auto-allow mode for local debugging
if (process.env.CODEKEY_HOOK_AUTO_ALLOW === '1') {
  log(`AUTO_ALLOW session=${event.session_id} tool=${event.tool_name}`);
  respond({ behavior: 'allow' });
  process.exit(0);
}

// Forward to bridge and wait for phone decision
const bridgeUrl = process.env.CODEKEY_BRIDGE_URL || 'http://127.0.0.1:3001';

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

const hookReq = http.request(`${bridgeUrl}/v1/codex-hooks/permission-request`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
  },
  timeout: 310_000, // slightly longer than bridge timeout
}, (res) => {
  let data = '';
  res.on('data', (chunk) => { data += chunk; });
  res.on('end', () => {
    if (res.statusCode < 200 || res.statusCode >= 300) {
      log(`BRIDGE_HTTP_ERROR status=${res.statusCode} body=${data.slice(0, 500)}`);
      bypass(`bridge_http_${res.statusCode}`);
    }
    try {
      const result = JSON.parse(data);
      if (result && result.bypass) {
        log(`BRIDGE_BYPASS reason=${result.reason || ''}`);
        return;
      }
      const dec = result.hookSpecificOutput?.decision || result.decision || {};
      log(`BRIDGE_DECISION behavior=${dec.behavior} msg=${dec.message || ''}`);
      respond({ behavior: dec.behavior || 'deny', message: dec.message });
    } catch (err) {
      log(`BRIDGE_RESPONSE_PARSE_ERROR: ${err.message} raw=${data.slice(0, 200)}`);
      bypass('bridge_response_parse_error');
    }
  });
});

hookReq.on('error', (err) => {
  log(`BRIDGE_ERROR: ${err.message}`);
  bypass('bridge_not_reachable');
});

hookReq.on('timeout', () => {
  hookReq.destroy();
  log(`BRIDGE_TIMEOUT`);
  bypass('bridge_timeout');
});

hookReq.write(body);
hookReq.end();
