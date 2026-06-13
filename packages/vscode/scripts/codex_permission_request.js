#!/usr/bin/env node
// CodeKey PermissionRequest hook for Codex
// Forwards permission requests to the CodeKey bridge for phone approval.
const BRIDGE_URL = process.env.CODEKEY_BRIDGE_URL || 'http://127.0.0.1:3001';
const HEALTH_TIMEOUT_MS = 1_500;
const TIMEOUT_MS = 300_000;
const DIAG_LOG = require('path').join(require('os').homedir(), '.codex', 'codekey-hook.log');
const DIAG_ENABLED = process.env.CODEKEY_DEBUG_LOG === '1';
const DIAG_MAX = 5 * 1024 * 1024;
const fs = require('fs');
function diag(msg) {
  if (!DIAG_ENABLED) return;
  try {
    try { const sz = fs.statSync(DIAG_LOG).size; if (sz >= DIAG_MAX) { try { fs.unlinkSync(DIAG_LOG + '.3'); } catch {} try { fs.renameSync(DIAG_LOG + '.2', DIAG_LOG + '.3'); } catch {} try { fs.renameSync(DIAG_LOG + '.1', DIAG_LOG + '.2'); } catch {} fs.renameSync(DIAG_LOG, DIAG_LOG + '.1'); } } catch {}
    fs.appendFileSync(DIAG_LOG, new Date().toISOString() + ' ' + msg + '\n');
  } catch {}
}
/** Sanitizer for diagnostic logging — aligned with handler.ts desensitize(). */
function sanitizeForDiag(raw) {
  return raw
    .replace(/-----BEGIN[\s\S]*?PRIVATE KEY-----[\s\S]*?-----END[\s\S]*?PRIVATE KEY-----/g, '-----BEGIN PRIVATE KEY-----\n***\n-----END PRIVATE KEY-----')
    .replace(/\bsk-[A-Za-z0-9_-]{12,}/g, 'sk-****')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{16,}/g, 'gh_****')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA****')
    .replace(/\b(Bearer\s+)[A-Za-z0-9._-]{12,}/gi, '$1****')
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s@]+@/gi, '$1****@')
    .replace(/\b(password|passwd|pwd|token|secret|api[_-]?key|access[_-]?key|auth[_-]?token)(\s*["']?\s*[=:]\s*["']?)([^\s"'&;,]+)/gi, '$1$2****');
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
    diag('health check failed: ' + sanitizeForDiag(err.message || err));
    return false;
  } finally {
    clearTimeout(timer);
  }
}

diag('hook started, BRIDGE_URL=' + BRIDGE_URL + ' args=' + sanitizeForDiag(process.argv.join(' ')));
let input = '';
process.stdin.setEncoding('utf-8');
process.stdin.on('data', (c) => { input += c; });
process.stdin.on('end', async () => {
  diag('stdin end, total input len=' + input.length);
  diag('input preview: ' + sanitizeForDiag(input.slice(0, 500)));
  try {
    const event = JSON.parse(input);
    diag('event keys: ' + Object.keys(event).join(', '));

    if (!input.trim() || !event || event.hook_event_name !== 'PermissionRequest') {
      diag('skip: unexpected event type or empty input');
      process.exit(0);
    }

    if (!(await bridgeReady())) {
      diag('bridge not ready, bypassing CodeKey');
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
      diag('fetch failed: ' + sanitizeForDiag(fetchErr.message || fetchErr));
      process.exit(0);
    }
    clearTimeout(timer);
    diag('bridge response: status=' + res.status + ' ' + res.statusText);
    if (!res.ok) { diag('bridge returned non-OK, exiting 0'); process.exit(0); }
    var result = await res.json();
    if (result && result.bypass) {
      diag('bridge requested bypass: ' + sanitizeForDiag(result.reason || ''));
      process.exit(0);
    }
    var dec = result.hookSpecificOutput?.decision || result.decision || {};
    diag('bridge decision behavior=' + dec.behavior + ' msg=' + sanitizeForDiag(dec.message || ''));
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: dec.behavior || 'deny', message: dec.message || 'Denied by CodeKey' },
      },
    }));
  } catch (err) {
    diag('hook error: ' + sanitizeForDiag(err?.message ?? err));
    process.exit(0);
  }
});
