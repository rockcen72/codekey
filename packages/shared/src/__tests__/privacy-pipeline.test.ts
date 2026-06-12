import { describe, it, expect, vi } from 'vitest';
import { runPrivacyPipeline, toCheckedPayload, truncateSafe } from '../bridge/privacy-pipeline.js';

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

    it('blocks transcript with blocked paths by default', () => {
      const result = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'read .env file',
        structuredPayload: { file_path: '.env' },
      });
      expect(result.blockedByDefault).toBe(true);
      expect(result.blockedPaths).toContain('.env');
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

    it('returns null for "block" decisions', () => {
      const decision = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'cat .env',
        structuredPayload: { file_path: '.env' },
      });
      const checked = toCheckedPayload(decision);
      expect(checked).toBeNull();
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
});
