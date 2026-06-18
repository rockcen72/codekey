import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { escapeClaudeProjectDir, extractUserPrompts, listRecentClaudeTranscripts, parseClaudeTranscriptLines } from './claude-transcripts.js';

/** Create temp transcript with given lines. Returns tmp dir path. */
function createTranscriptFixture(sessionId: string, lines: string[]): string {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ck-transcript-test-'));
  const projectDir = join(tmpDir, 'projects', 'test-project');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, `${sessionId}.jsonl`), lines.join('\n') + '\n');
  return tmpDir;
}

describe('claude transcript parser', () => {
  it('extracts metadata from session_id, cwd, timestamp, and first user message', () => {
    const lines = [
      JSON.stringify({
        type: 'system',
        session_id: 'sid-1',
        cwd: 'F:\\Work\\Codekey',
        timestamp: '2026-05-27T10:00:00.000Z',
      }),
      JSON.stringify({
        type: 'user',
        session_id: 'sid-1',
        cwd: 'F:\\Work\\Codekey',
        timestamp: '2026-05-27T10:01:00.000Z',
        message: { role: 'user', content: '帮我修复多会话绑定问题' },
      }),
    ];

    const meta = parseClaudeTranscriptLines(lines, 'sid-1', 'C:\\Users\\me\\.claude\\projects\\x\\sid-1.jsonl');

    expect(meta.sessionId).toBe('sid-1');
    expect(meta.cwd).toBe('F:\\Work\\Codekey');
    expect(meta.title).toBe('帮我修复多会话绑定问题');
    expect(meta.createdAt).toBe('2026-05-27T10:00:00.000Z');
    expect(meta.updatedAt).toBe('2026-05-27T10:01:00.000Z');
  });

  it('ignores tool-only and slash-command-only titles', () => {
    const lines = [
      JSON.stringify({
        type: 'user',
        session_id: 'sid-2',
        timestamp: '2026-05-27T10:00:00.000Z',
        message: { role: 'user', content: '/compact' },
      }),
      JSON.stringify({
        type: 'user',
        session_id: 'sid-2',
        timestamp: '2026-05-27T10:01:00.000Z',
        message: { role: 'user', content: [{ type: 'tool_result', content: 'ignored' }] },
      }),
    ];

    const meta = parseClaudeTranscriptLines(lines, 'sid-2', 'C:\\Users\\me\\.claude\\projects\\x\\sid-2.jsonl');

    expect(meta.title).toBe('sid-2');
  });

  it('uses the latest meaningful user prompt for recent session display title', async () => {
    const sessionId = 'sid-latest-title';
    const tmpDir = createTranscriptFixture(sessionId, [
      JSON.stringify({ type: 'user', session_id: sessionId, cwd: 'F:\\Work\\Codekey', timestamp: '2026-05-27T10:00:00.000Z', message: { role: 'user', content: '你好' } }),
      JSON.stringify({ type: 'assistant', session_id: sessionId, timestamp: '2026-05-27T10:01:00.000Z', message: { role: 'assistant', content: '你好' } }),
      JSON.stringify({ type: 'user', session_id: sessionId, timestamp: '2026-05-27T10:02:00.000Z', message: { role: 'user', content: '帮我修复侧边栏会话标题' } }),
    ]);
    process.env.CLAUDE_CONFIG_DIR = tmpDir;
    try {
      const sessions = await listRecentClaudeTranscripts(5);
      expect(sessions.find(s => s.sessionId === sessionId)?.title).toBe('帮我修复侧边栏会话标题');
    } finally {
      delete process.env.CLAUDE_CONFIG_DIR;
    }
  });

  it('escapes project directory using Claude transcript directory convention', () => {
    expect(escapeClaudeProjectDir('F:\\Work\\Codekey')).toContain('F-Work-Codekey');
  });

  describe('extractUserPrompts', () => {
    const sessionId = 'test-extract';

    it('extracts user messages from transcript lines', async () => {
      const tmpDir = createTranscriptFixture(sessionId, [
        JSON.stringify({ type: 'system', timestamp: '2026-05-28T10:00:00Z' }),
        JSON.stringify({ type: 'user', timestamp: '2026-05-28T10:01:00Z', message: { role: 'user', content: '帮我查纽约天气' } }),
        JSON.stringify({ type: 'assistant', timestamp: '2026-05-28T10:02:00Z', message: { role: 'assistant', content: '好的' } }),
        JSON.stringify({ type: 'user', timestamp: '2026-05-28T10:03:00Z', message: { role: 'user', content: '然后查伦敦' } }),
      ]);
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const result = await extractUserPrompts(sessionId);
        expect(result).toHaveLength(2);
        expect(result[0].text).toBe('帮我查纽约天气');
        expect(result[1].text).toBe('然后查伦敦');
        expect(result[1].index).toBeGreaterThan(result[0].index);
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('ignores isMeta and tool_result lines', async () => {
      const tmpDir = createTranscriptFixture(sessionId, [
        JSON.stringify({ type: 'user', isMeta: true, timestamp: '2026-05-28T10:00:00Z', message: { role: 'user', content: 'meta ignored' } }),
        JSON.stringify({ type: 'user', timestamp: '2026-05-28T10:01:00Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'output' }] } }),
        JSON.stringify({ type: 'user', timestamp: '2026-05-28T10:02:00Z', message: { role: 'user', content: 'real prompt' } }),
      ]);
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const result = await extractUserPrompts(sessionId);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('real prompt');
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('strips leading IDE XML context tags', async () => {
      const tmpDir = createTranscriptFixture(sessionId, [
        JSON.stringify({ type: 'user', timestamp: '2026-05-28T10:00:00Z', message: { role: 'user', content: '<ide_opened_file>src/index.ts</ide_opened_file> 帮我修复这个文件' } }),
      ]);
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const result = await extractUserPrompts(sessionId);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('帮我修复这个文件');
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('respects maxCount and keeps old-to-new order', async () => {
      const tmpDir = createTranscriptFixture(sessionId, [1, 2, 3, 4, 5].map(i =>
        JSON.stringify({ type: 'user', timestamp: `2026-05-28T10:0${i}:00Z`, message: { role: 'user', content: `prompt ${i}` } }),
      ));
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const result = await extractUserPrompts(sessionId, 3);
        expect(result).toHaveLength(3);
        expect(result[0].text).toBe('prompt 3'); // oldest of last 3
        expect(result[2].text).toBe('prompt 5'); // newest
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });

    it('filters out control-only commands', async () => {
      const tmpDir = createTranscriptFixture(sessionId, [
        JSON.stringify({ type: 'user', timestamp: '2026-05-28T10:00:00Z', message: { role: 'user', content: '/compact' } }),
        JSON.stringify({ type: 'user', timestamp: '2026-05-28T10:01:00Z', message: { role: 'user', content: 'real question' } }),
      ]);
      process.env.CLAUDE_CONFIG_DIR = tmpDir;
      try {
        const result = await extractUserPrompts(sessionId);
        expect(result).toHaveLength(1);
        expect(result[0].text).toBe('real question');
      } finally {
        delete process.env.CLAUDE_CONFIG_DIR;
      }
    });
  });
});
