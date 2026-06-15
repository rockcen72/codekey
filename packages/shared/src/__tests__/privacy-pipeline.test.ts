import { describe, it, expect, vi } from 'vitest';
import { runPrivacyPipeline, toCheckedPayload, truncateSafe, PrivacyAuditCollector, projectAllowedFields, projectHistoryEventForPolicy } from '../bridge/privacy-pipeline.js';
import { SANITIZED_ALLOWED_FIELDS } from '../bridge/history-policy.js';

describe('privacy-pipeline', () => {
  describe('runPrivacyPipeline', () => {
    it('sanitizes an API key in command text', () => {
      const result = runPrivacyPipeline({
        source: 'approval',
        rawPayload: 'export ANTHROPIC_API_KEY=sk-ant-ABCDEFGHIJKLMNOPQRST',
      });
      expect(result.sanitizedPayload).toContain('sk-ant-***');
      expect(result.sanitizedPayload).not.toContain('sk-ant-ABCDEFGHIJKLMNOPQRST');
      expect(result.sanitizedFindings.length).toBeGreaterThanOrEqual(1);
      expect(result.action).toBe('send');
    });

    it('handles normal-length payloads', () => {
      const normal = 'x'.repeat(1000);
      const result = runPrivacyPipeline({ source: 'approval', rawPayload: normal });
      expect(result.truncated).toBe(false);
      expect(result.action).toBe('send');
    });

    it('returns skip for empty payload', () => {
      const result = runPrivacyPipeline({ source: 'approval', rawPayload: '' });
      expect(result.action).toBe('skip');
    });

    it('redacts blocked paths in transcript mentions (audit r5)', () => {
      const result = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'check ~/.codekey/credentials.json',
        structuredPayload: { file_path: 'credentials.json' },
      });
      expect(result.blockedByDefault).toBe(true);
      expect(result.blockedPaths).toContain('credentials.json');
      // Bare mention — no config content pattern, so it gets redacted and sent
      expect(result.action).toBe('send');
      expect(result.redactedDueToBlockedPath).toBe(true);
      expect(result.sanitizedPayload).toContain('[blocked path]');
      expect(result.sanitizedPayload).not.toContain('credentials.json');
    });

    it('blocks transcript that dumps config file content (key=value lines)', () => {
      const result = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'cat .env\nDB_PASSWORD=secret\nAPI_KEY=12345',
        structuredPayload: { file_path: '.env' },
      });
      expect(result.blockedByDefault).toBe(true);
      expect(result.blockedPaths).toContain('.env');
      // Config content detected (2+ lines with = or :) — block
      expect(result.action).toBe('block');
      expect(result.redactedDueToBlockedPath).toBeFalsy();
    });

    it('blocks transcript with single-line JSON credentials dump (audit r6 P1)', () => {
      const result = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'credentials.json {"deviceToken":"abc123","deviceSecret":"xyz789"}',
        structuredPayload: { file_path: 'credentials.json' },
      });
      expect(result.blockedByDefault).toBe(true);
      expect(result.blockedPaths).toContain('credentials.json');
      // Single-line JSON with credential field names — block
      expect(result.action).toBe('block');
      expect(result.redactedDueToBlockedPath).toBeFalsy();
    });

    it('blocks transcript with sensitive field name (token/secret/password/key/credential)', () => {
      const result = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'here is your password: abc123def456',
        structuredPayload: { file_path: 'credentials.json' },
      });
      expect(result.blockedByDefault).toBe(true);
      expect(result.blockedPaths).toContain('credentials.json');
      // Sensitive field name in text — block
      expect(result.action).toBe('block');
    });

    it('requires confirmation for approval with .codekeyignore hit', () => {
      // Without cwd, no .codekeyignore is loaded, so only default blocklist applies
      const result = runPrivacyPipeline({
        source: 'approval',
        rawPayload: 'cat /project/.env',
        extraPaths: ['/project/.env'],
      });
      expect(result.blockedByDefault).toBe(true);
      expect(result.action).toBe('require_confirmation');
    });

    it('calls audit sink when provided', () => {
      const sink = vi.fn();
      runPrivacyPipeline(
        { source: 'command', rawPayload: 'ls -la' },
        undefined,
        sink,
      );
      expect(sink).toHaveBeenCalledTimes(1);
      const entry = sink.mock.calls[0][0];
      expect(entry.source).toBe('command');
      expect(entry.action).toBe('forwarded');
      expect(entry.sanitized).toBe(false);
    });

    it('records sanitized in audit when secrets found', () => {
      const sink = vi.fn();
      runPrivacyPipeline(
        { source: 'approval', rawPayload: 'key=sk-ant-ABCDEFGHIJKLMNOPQRST' },
        undefined,
        sink,
      );
      expect(sink).toHaveBeenCalledTimes(1);
      expect(sink.mock.calls[0][0].action).toBe('sanitized');
      expect(sink.mock.calls[0][0].sanitized).toBe(true);
    });

    it('adds readable audit preview fields for forwarded user prompts', () => {
      const sink = vi.fn();
      const rawPayload = JSON.stringify({
        type: 'event',
        payload: {
          sessionId: 'session-1',
          eventType: 'user_prompt',
          data: { type: 'user_prompt', prompt: '帮我检查 OpenCode 历史记录' },
        },
      });

      runPrivacyPipeline({ source: 'history', rawPayload }, undefined, sink);

      const entry = sink.mock.calls[0][0];
      expect(entry.eventType).toBe('user_prompt');
      expect(entry.displayText).toBe('帮我检查 OpenCode 历史记录');
      expect(entry.previewKind).toBe('content');
    });

    it('marks summary-mode audit previews instead of showing generic prompt text as content', () => {
      const sink = vi.fn();
      const rawPayload = JSON.stringify({
        type: 'event',
        payload: {
          sessionId: 'session-1',
          eventType: 'user_prompt',
          data: { type: 'user_prompt', summary: 'User prompt' },
        },
      });

      runPrivacyPipeline(
        { source: 'history', rawPayload, allowedFields: ['type', 'summary'] },
        undefined,
        sink,
      );

      const entry = sink.mock.calls[0][0];
      expect(entry.eventType).toBe('user_prompt');
      expect(entry.displayText).toBe('');
      expect(entry.previewKind).toBe('summary');
    });

    it('blocks .env file in transcript', () => {
      const result = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'cat .env',
        structuredPayload: { file_path: '.env' },
      });
      expect(result.blockedPaths).toContain('.env');
    });
  });

  describe('toCheckedPayload', () => {
    it('produces a checked payload for "send" decisions', () => {
      const decision = runPrivacyPipeline({
        source: 'command',
        rawPayload: 'echo hello',
      });
      const checked = toCheckedPayload(decision);
      expect(checked).not.toBeNull();
      expect(checked!.raw).toBe('echo hello');
      expect(checked!.__privacyChecked).toBe(true);
      expect(checked!.checkedAt).toBeGreaterThan(0);
    });

    it('redacts blocked paths in transcript instead of blocking (audit r5)', () => {
      const decision = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'cat .env',
        structuredPayload: { file_path: '.env' },
      });
      expect(decision.blockedByDefault).toBe(true);
      expect(decision.blockedPaths).toContain('.env');
      // Audit r5: transcript events that MENTION a blocked path should NOT be
      // silently dropped — the path is replaced with [blocked path] and sent.
      expect(decision.action).toBe('send');
      expect(decision.sanitizedPayload).toContain('[blocked path]');
      expect(decision.sanitizedPayload).not.toContain('.env');
      const checked = toCheckedPayload(decision);
      expect(checked).not.toBeNull();
      expect(checked!.raw).toContain('[blocked path]');
    });

    it('produces a checked payload for "require_confirmation" decisions', () => {
      const decision = runPrivacyPipeline({
        source: 'approval',
        rawPayload: 'cat /project/.env',
        extraPaths: ['/project/.env'],
      });
      expect(decision.action).toBe('require_confirmation');
      const checked = toCheckedPayload(decision);
      expect(checked).not.toBeNull();
      expect(checked!.__privacyChecked).toBe(true);
      expect(checked!.checkedAt).toBeGreaterThan(0);
    });

    describe('truncateSafe (JSON integrity)', () => {
  it('produces valid JSON when error message exceeds command MAX_LENGTH (5000)', () => {
    const longMsg = 'x'.repeat(6000);
    const raw = JSON.stringify({
      type: 'event',
      payload: {
        clientEventId: 'err:abc:1',
        sessionId: 'sess-1',
        eventType: 'error',
        data: { type: 'error', message: longMsg },
        ts: '2026-06-12T00:00:00.000Z',
      },
    });
    const result = truncateSafe(raw, 5000);
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('preserves valid JSON for approval payload with long command text', () => {
    const longCmd = 'cmd ' + 'arg '.repeat(2000);
    const raw = JSON.stringify({ type: 'approval', payload: { command: longCmd } });
    const result = truncateSafe(raw, 5000);
    expect(result.length).toBeLessThanOrEqual(5000);
    const parsed = JSON.parse(result);
    expect(parsed).toHaveProperty('type', 'approval');
  });

  it('truncateSafe passes through short payloads unchanged', () => {
    const raw = JSON.stringify({ type: 'event', payload: { msg: 'hello' } });
    expect(truncateSafe(raw, 10000)).toBe(raw);
  });

  it('guarantees valid JSON <= maxLen even with many small string fields', () => {
    // 60 fields × 100 chars + structure ≈ 6500+ chars, exceeding 5000 limit
    const fields: Record<string, string> = {};
    for (let i = 0; i < 60; i++) fields[`f${i}`] = 'x'.repeat(200);
    const raw = JSON.stringify({ type: 'event', payload: fields });
    expect(raw.length).toBeGreaterThan(5000);
    const result = truncateSafe(raw, 5000);
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(() => JSON.parse(result)).not.toThrow();
  });

  it('drops trailing fields when structure alone exceeds maxLen (squeeze fallback)', () => {
    // 700 fields × 1-char strings → structure ~7600 chars, exceeds 5000
    // squeezeToMaxLen must drop trailing fields so total fits
    const fields: Record<string, string> = {};
    for (let i = 0; i < 700; i++) fields[`f${i}`] = 'x';
    const raw = JSON.stringify({ type: 'event', payload: fields });
    expect(raw.length).toBeGreaterThan(5000);
    const result = truncateSafe(raw, 5000);
    expect(result.length).toBeLessThanOrEqual(5000);
    expect(() => JSON.parse(result)).not.toThrow();
    const parsed = JSON.parse(result) as { type: string; payload: Record<string, string> };
    // At strLimit=1 every string is 1 char ("event" → "e")
    expect(parsed.type).toBe('e');
    // payload survived with early fields intact, trailing ones dropped
    expect(Object.keys(parsed.payload).length).toBeGreaterThan(0);
    expect(parsed.payload).toHaveProperty('f0');
  });
});

// Regression: approval payload with both blocked path AND secret
    // must produce a checked payload whose raw is the SANITIZED version,
    // not the original rawPayload (privacy bypass CVE prevention).
    it('sanitizes secrets even when approval requires confirmation (.env + token)', () => {
      const raw = `I need to read /project/.env to get the key\nAPI_KEY=sk-ant-ABCDEFGHIJKLMNOPQRST`;
      const decision = runPrivacyPipeline({
        source: 'approval',
        rawPayload: raw,
        extraPaths: ['/project/.env'],
      });
      expect(decision.action).toBe('require_confirmation');
      const checked = toCheckedPayload(decision);
      expect(checked).not.toBeNull();
      // The checked payload must have the secret redacted
      expect(checked!.raw).toContain('sk-ant-***');
      expect(checked!.raw).not.toContain('sk-ant-ABCDEFGHIJKLMNOPQRST');
    });
  });

  describe('PrivacyAuditCollector', () => {
    it('accumulates forwarded entries and tracks stats', () => {
      const collector = new PrivacyAuditCollector();
      const sink = collector.sink;
      sink({ timestamp: 't1', source: 'command', action: 'forwarded', sanitized: false, blocked: false, payloadPreview: 'ls', findingCount: 0, payloadLength: 4 });
      sink({ timestamp: 't2', source: 'approval', action: 'forwarded', sanitized: false, blocked: false, payloadPreview: 'git push', findingCount: 0, payloadLength: 8 });
      expect(collector.stats().summary.forwarded).toBe(2);
      expect(collector.stats().summary.blocked).toBe(0);
      expect(collector.stats().summary.sanitized).toBe(0);
      expect(collector.stats().summary.totalFindings).toBe(0);
      expect(collector.stats().recentEntries.length).toBe(2);
    });

    it('tracks sanitized and blocked entries separately', () => {
      const collector = new PrivacyAuditCollector();
      const sink = collector.sink;
      sink({ timestamp: 't1', source: 'approval', action: 'sanitized', sanitized: true, blocked: false, payloadPreview: 'key=sk-ant-xxx', findingCount: 1, payloadLength: 20 });
      sink({ timestamp: 't2', source: 'transcript', action: 'blocked', sanitized: false, blocked: true, payloadPreview: '.env contents', findingCount: 0, payloadLength: 13 });
      sink({ timestamp: 't3', source: 'history', action: 'forwarded', sanitized: false, blocked: false, payloadPreview: 'ls', findingCount: 0, payloadLength: 2 });
      const stats = collector.stats();
      expect(stats.summary.forwarded).toBe(1);
      expect(stats.summary.blocked).toBe(1);
      expect(stats.summary.sanitized).toBe(1);
      expect(stats.summary.totalFindings).toBe(1);
    });

    it('accumulates totalFindings across multiple entries', () => {
      const collector = new PrivacyAuditCollector();
      const sink = collector.sink;
      sink({ timestamp: 't1', source: 'approval', action: 'sanitized', sanitized: true, blocked: false, payloadPreview: 'a', findingCount: 2, payloadLength: 5 });
      sink({ timestamp: 't2', source: 'approval', action: 'sanitized', sanitized: true, blocked: false, payloadPreview: 'b', findingCount: 3, payloadLength: 5 });
      expect(collector.stats().summary.totalFindings).toBe(5);
    });

    it('ring buffer caps at MAX_AUDIT_ENTRIES (500)', () => {
      const collector = new PrivacyAuditCollector();
      const sink = collector.sink;
      for (let i = 0; i < 600; i++) {
        sink({ timestamp: `t${i}`, source: 'command', action: 'forwarded', sanitized: false, blocked: false, payloadPreview: 'x', findingCount: 0, payloadLength: 1 });
      }
      expect(collector.stats().recentEntries.length).toBeLessThanOrEqual(500);
      // oldest entries are dropped
      expect(collector.stats().recentEntries[0].timestamp).not.toBe('t0');
    });

    it('reset clears all state', () => {
      const collector = new PrivacyAuditCollector();
      collector.sink({ timestamp: 't1', source: 'approval', action: 'sanitized', sanitized: true, blocked: false, payloadPreview: 'sk-xxx', findingCount: 2, payloadLength: 6 });
      expect(collector.stats().summary.sanitized).toBe(1);
      collector.reset();
      const stats = collector.stats();
      expect(stats.summary.forwarded).toBe(0);
      expect(stats.summary.blocked).toBe(0);
      expect(stats.summary.sanitized).toBe(0);
      expect(stats.summary.totalFindings).toBe(0);
      expect(stats.recentEntries).toEqual([]);
    });
  });

  // ── Audit r2 P1-B: Sanitized projection MUST preserve encryption envelope markers ──
  describe('encryption envelope survives Sanitized projection', () => {
    function makeEncryptedRaw(): string {
      return JSON.stringify({
        type: 'event',
        payload: {
          clientEventId: 'cevt:claude-a:7',
          sessionId: 'sess-1',
          agent: 'claude-code-hook',
          eventType: 'user_prompt',
          data: {
            type: 'user_prompt',
            encrypted: true,
            safe_summary: 'User prompt',
            preview_label: 'user_prompt',
            // sensitive — must NOT survive projection
            prompt: 'leaky body should not be in projection',
          },
          sealed_payload: 'AbCdEf...==',
          key_id: 'keyid-abc',
          encryption_version: 1,
          ts: '2026-06-14T00:00:00.000Z',
        },
      });
    }

    it('projectAllowedFields keeps encrypted/safe_summary/preview_label and drops prompt', () => {
      const projected = projectAllowedFields(makeEncryptedRaw(), SANITIZED_ALLOWED_FIELDS);
      const root = JSON.parse(projected);
      const data = root.payload.data;
      expect(data).toHaveProperty('encrypted', true);
      expect(data).toHaveProperty('safe_summary', 'User prompt');
      expect(data).toHaveProperty('preview_label', 'user_prompt');
      expect(data).not.toHaveProperty('prompt');
    });

    it('projectAllowedFields preserves outer envelope sealed_payload/key_id/encryption_version', () => {
      const projected = projectAllowedFields(makeEncryptedRaw(), SANITIZED_ALLOWED_FIELDS);
      const root = JSON.parse(projected);
      const payload = root.payload;
      expect(payload.sealed_payload).toBe('AbCdEf...==');
      expect(payload.key_id).toBe('keyid-abc');
      expect(payload.encryption_version).toBe(1);
    });

    it('projectHistoryEventForPolicy with Sanitized policy preserves envelope + drops prompt', () => {
      const projected = projectHistoryEventForPolicy(
        makeEncryptedRaw(),
        { allowed: true, allowedFields: SANITIZED_ALLOWED_FIELDS },
      );
      expect(projected).not.toBeNull();
      const root = JSON.parse(projected!);
      const data = root.payload.data;
      expect(data).toHaveProperty('encrypted', true);
      expect(data).not.toHaveProperty('prompt');
      expect(root.payload.sealed_payload).toBe('AbCdEf...==');
    });

    it('encryption_error placeholder survives projection', () => {
      const raw = JSON.stringify({
        type: 'event',
        payload: {
          clientEventId: 'cevt:err:1',
          sessionId: 'sess-1',
          eventType: 'user_prompt',
          data: {
            type: 'user_prompt',
            encryption_error: true,
            safe_summary: 'Encryption failed',
            preview_label: 'encryption_error',
          },
          ts: '2026-06-14T00:00:00.000Z',
        },
      });
      const projected = projectAllowedFields(raw, SANITIZED_ALLOWED_FIELDS);
      const root = JSON.parse(projected);
      expect(root.payload.data).toHaveProperty('encryption_error', true);
      expect(root.payload.data).toHaveProperty('safe_summary', 'Encryption failed');
      expect(root.payload.data).toHaveProperty('preview_label', 'encryption_error');
    });
  });
});
