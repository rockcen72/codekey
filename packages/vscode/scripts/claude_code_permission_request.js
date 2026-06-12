#!/usr/bin/env node
// CodeKey PermissionRequest hook for Claude Code
// Forwards Bash tool permission requests to the CodeKey bridge for phone approval.
const BRIDGE_URL = 'http://127.0.0.1:3001';
const HEALTH_TIMEOUT_MS = 1_500;
const TIMEOUT_MS = 120_000;
const DIAG_LOG = require('path').join(require('os').homedir(), '.claude', 'codekey-permission-diagnostic.log');
const DIAG_ENABLED = process.env.CODEKEY_DEBUG_LOG === '1';
const fs = require('fs');
function diag(msg) {
  if (!DIAG_ENABLED) return;
  try { fs.appendFileSync(DIAG_LOG, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
}
/** Minimal sanitizer for diagnostic logging — redacts common secret patterns. */
function sanitizeForDiag(raw) {
  return raw
    .replace(/sk-[A-Za-z0-9]{20,}/g, 'sk-***')
    .replace(/sk-ant-[A-Za-z0-9]{20,}/g, 'sk-ant-***')
    .replace(/ghp_[A-Za-z0-9]{36}/g, 'ghp_***')
    .replace(/AKIA[0-9A-Z]{16}/g, 'AKIA***')
    .replace(/Bearer\s+[A-Za-z0-9\-._~+/]{20,}/g, 'Bearer ***')
    .replace(/-----BEGIN\s+(RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(RSA\s+)?PRIVATE\s+KEY-----/g, '-----BEGIN PRIVATE KEY-----\n***\n-----END PRIVATE KEY-----');
}

async function bridgeReady() {
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(BRIDGE_URL + '/v1/health', { signal: ctrl.signal });
    if (!res.ok) {
      diag('health check non-OK: ' + res.status);
      return false;
    }
    const health = await res.json();
    if (health.relay !== 'connected') {
      diag('health check bypass: relay=' + (health.relay || '(missing)'));
      return false;
    }
    return true;
  } catch (err) {
    diag('health check failed: ' + (err.message || err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function isSessionAttached(sessionId) {
  if (!sessionId) return false;
  const ctrl = new AbortController();
  const timer = setTimeout(function () { ctrl.abort(); }, HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(BRIDGE_URL + '/v1/attached-sessions', { signal: ctrl.signal });
    if (!res.ok) {
      diag('attached-sessions non-OK: ' + res.status);
      return false;
    }
    const body = await res.json();
    const attached = Array.isArray(body && body.attached) ? body.attached : [];
    const ok = attached.includes(sessionId);
    diag('attached-sessions check: sid=' + sessionId + ' attached=' + ok + ' total=' + attached.length);
    return ok;
  } catch (err) {
    diag('attached-sessions check failed: ' + (err.message || err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

diag('hook started, BRIDGE_URL=' + BRIDGE_URL + ' args=' + process.argv.join(' '));
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  diag('stdin end, total input len=' + input.length);
  diag('input preview: ' + sanitizeForDiag(input.slice(0, 500)));
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

    if (!(await bridgeReady())) {
      diag('bridge not ready, bypassing CodeKey');
      process.exit(0);
    }

    if (!(await isSessionAttached(sid))) {
      diag('session not attached, bypassing CodeKey approval');
      process.exit(0);
    }

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
    if (result && result.bypass) {
      diag('bridge requested bypass: ' + (result.reason || ''));
      process.exit(0);
    }
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
