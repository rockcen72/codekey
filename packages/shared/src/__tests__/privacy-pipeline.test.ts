import { describe, it, expect, vi } from 'vitest';
import { runPrivacyPipeline, toCheckedPayload } from '../bridge/privacy-pipeline.js';

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

    it('returns null for non-send decisions', () => {
      const decision = runPrivacyPipeline({
        source: 'transcript',
        rawPayload: 'cat .env',
        structuredPayload: { file_path: '.env' },
      });
      const checked = toCheckedPayload(decision);
      expect(checked).toBeNull();
    });
  });
});
