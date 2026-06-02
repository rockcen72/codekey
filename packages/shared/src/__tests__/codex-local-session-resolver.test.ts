import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  codexConfigDir,
  parseSessionIndex,
  readSessionMeta,
  discoverLocalSessions,
  findMostRecentSession,
  cleanCodexDisplayText,
  type CodexLocalSession,
} from '../bridge/codex-local-session-resolver.js';

// Mock fs and os for isolated testing
vi.mock('node:os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    existsSync: vi.fn(actual.existsSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
    statSync: vi.fn(actual.statSync),
    fstatSync: vi.fn(actual.fstatSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});

describe('codex-local-session-resolver', () => {
  const mockCodexDir = '/mock/home/.codex';
  const mockSessionsDir = path.join(mockCodexDir, 'sessions');
  const mockSessionIndex = path.join(mockCodexDir, 'session_index.jsonl');

  beforeEach(() => {
    vi.clearAllMocks();
    // Default: codexConfigDir returns mock path
    vi.mocked(os.homedir).mockReturnValue('/mock/home');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('codexConfigDir', () => {
    it('returns CODEX_HOME env var when set', () => {
      const original = process.env.CODEX_HOME;
      process.env.CODEX_HOME = '/custom/codex';
      expect(codexConfigDir()).toBe('/custom/codex');
      process.env.CODEX_HOME = original;
    });

    it('returns ~/.codex when CODEX_HOME not set', () => {
      const original = process.env.CODEX_HOME;
      delete process.env.CODEX_HOME;
      const result = codexConfigDir();
      expect(result).toContain('.codex');
      expect(result).toContain('mock');
      expect(result).toContain('home');
      process.env.CODEX_HOME = original;
    });

    it('trims whitespace from CODEX_HOME', () => {
      const original = process.env.CODEX_HOME;
      process.env.CODEX_HOME = '  /custom/codex  ';
      expect(codexConfigDir()).toBe('/custom/codex');
      process.env.CODEX_HOME = original;
    });
  });

  describe('parseSessionIndex', () => {
    it('returns empty array for non-existent file', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(parseSessionIndex('/nonexistent.jsonl')).toEqual([]);
    });

    it('parses valid session index entries', () => {
      const content = [
        '{"id":"session-1","thread_name":"Test Session","updated_at":"2026-06-01T10:00:00Z"}',
        '{"id":"session-2","thread_name":"Another Session"}',
      ].join('\n');

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const result = parseSessionIndex('/mock/index.jsonl');
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe('session-1');
      expect(result[0].thread_name).toBe('Test Session');
      expect(result[1].id).toBe('session-2');
    });

    it('skips malformed lines', () => {
      const content = [
        '{"id":"session-1"}',
        'invalid json',
        '{"id":"session-2"}',
      ].join('\n');

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const result = parseSessionIndex('/mock/index.jsonl');
      expect(result).toHaveLength(2);
    });

    it('skips entries without id', () => {
      const content = [
        '{"id":"session-1"}',
        '{"thread_name":"no-id-session"}',
      ].join('\n');

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'readFileSync').mockReturnValue(content);

      const result = parseSessionIndex('/mock/index.jsonl');
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('session-1');
    });
  });

  describe('readSessionMeta', () => {
    it('returns null for non-existent file', () => {
      vi.spyOn(fs, 'existsSync').mockReturnValue(false);
      expect(readSessionMeta('/nonexistent.jsonl')).toBeNull();
    });

    it('extracts session_meta from first lines', () => {
      const lines = [
        '{"type":"session_meta","payload":{"id":"test-session","cwd":"/workspace","source":"vscode"}}',
        '{"type":"user","message":{"role":"user","content":"hello"}}',
      ].join('\n');

      // Mock the file read by creating a buffer
      const mockBuffer = Buffer.from(lines);
      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'openSync').mockReturnValue(3 as any);
      vi.spyOn(fs, 'readSync').mockImplementation(function(fd: any, buffer: any, offset: any, length: any, position: any) {
        mockBuffer.copy(buffer as Buffer, offset, position || 0, (position || 0) + length);
        return Math.min(length, mockBuffer.length - (position || 0));
      } as any);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({ size: mockBuffer.length } as any);
      vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

      const result = readSessionMeta('/mock/session.jsonl');
      expect(result).not.toBeNull();
      expect(result?.id).toBe('test-session');
      expect(result?.cwd).toBe('/workspace');
      expect(result?.source).toBe('vscode');
    });

    it('returns null when no session_meta found', () => {
      const lines = '{"type":"user","message":{"role":"user","content":"hello"}}';
      const mockBuffer = Buffer.from(lines);

      vi.spyOn(fs, 'existsSync').mockReturnValue(true);
      vi.spyOn(fs, 'openSync').mockReturnValue(3 as any);
      vi.spyOn(fs, 'readSync').mockImplementation(function(fd: any, buffer: any, offset: any, length: any, position: any) {
        mockBuffer.copy(buffer as Buffer, offset, position || 0, (position || 0) + length);
        return Math.min(length, mockBuffer.length - (position || 0));
      } as any);
      vi.spyOn(fs, 'fstatSync').mockReturnValue({ size: mockBuffer.length } as any);
      vi.spyOn(fs, 'closeSync').mockReturnValue(undefined);

      const result = readSessionMeta('/mock/session.jsonl');
      expect(result).toBeNull();
    });
  });

  describe('discoverLocalSessions', () => {
    it('returns empty array when sessions directory does not exist', () => {
      // Use a non-existent CODEX_HOME to guarantee empty results
      const original = process.env.CODEX_HOME;
      process.env.CODEX_HOME = '/nonexistent/.codex';
      const result = discoverLocalSessions();
      expect(result).toEqual([]);
      process.env.CODEX_HOME = original;
    });

    it('discovers sessions from transcript files', () => {
      const original = process.env.CODEX_HOME;
      process.env.CODEX_HOME = '/nonexistent/.codex';
      const result = discoverLocalSessions();
      expect(Array.isArray(result)).toBe(true);
      process.env.CODEX_HOME = original;
    });
  });

  describe('findMostRecentSession', () => {
    it('returns null when no sessions found', () => {
      const original = process.env.CODEX_HOME;
      process.env.CODEX_HOME = '/nonexistent/.codex';
      expect(findMostRecentSession('/workspace')).toBeNull();
      process.env.CODEX_HOME = original;
    });
  });

  describe('cleanCodexDisplayText', () => {
    it('keeps only the real user request from IDE context blocks', () => {
      const text = [
        '# Context from my IDE setup:',
        '',
        '## Open tabs:',
        '- server-deployment.md: docs/server-deployment.md',
        '',
        '## My request for Codex:',
        '请排查 Codex 手机端消息上下文太多的问题',
      ].join('\n');

      expect(cleanCodexDisplayText(text)).toBe('请排查 Codex 手机端消息上下文太多的问题');
    });

    it('drops pure host-injected context blocks', () => {
      expect(cleanCodexDisplayText('<environment_context>\n  <cwd>f:\\Work\\Codekey</cwd>\n</environment_context>')).toBe('');
      expect(cleanCodexDisplayText('# AGENTS.md instructions for f:\\Work\\Codekey\n\n<INSTRUCTIONS>\n...\n</INSTRUCTIONS>')).toBe('');
    });
  });
});
