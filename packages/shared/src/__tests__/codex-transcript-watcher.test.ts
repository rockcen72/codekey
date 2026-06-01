import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexTranscriptWatcher, type TranscriptEvent } from '../bridge/codex-transcript-watcher.js';
import * as fs from 'node:fs';

// Mock fs module
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  statSync: vi.fn(),
  readFileSync: vi.fn(),
  watch: vi.fn(),
}));

describe('CodexTranscriptWatcher', () => {
  let watcher: CodexTranscriptWatcher;
  const mockPath = '/mock/session.jsonl';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.statSync).mockReturnValue({ size: 0 } as any);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.watch).mockReturnValue({
      close: vi.fn(),
      on: vi.fn(),
    } as any);

    watcher = new CodexTranscriptWatcher({
      transcriptPath: mockPath,
      pollIntervalMs: 100,
    });
  });

  afterEach(() => {
    watcher.stop();
  });

  describe('constructor', () => {
    it('should initialize with correct path', () => {
      expect(watcher.getPath()).toBe(mockPath);
    });

    it('should not be running initially', () => {
      expect(watcher.isRunning()).toBe(false);
    });
  });

  describe('start/stop', () => {
    it('should start watching', () => {
      watcher.start();
      expect(watcher.isRunning()).toBe(true);
    });

    it('should stop watching', () => {
      watcher.start();
      watcher.stop();
      expect(watcher.isRunning()).toBe(false);
    });

    it('should emit started event', () => {
      const startedHandler = vi.fn();
      watcher.on('started', startedHandler);

      watcher.start();
      expect(startedHandler).toHaveBeenCalledWith({ path: mockPath });
    });

    it('should emit stopped event', () => {
      const stoppedHandler = vi.fn();
      watcher.on('stopped', stoppedHandler);

      watcher.start();
      watcher.stop();
      expect(stoppedHandler).toHaveBeenCalledWith({ path: mockPath });
    });

    it('should not start twice', () => {
      const startedHandler = vi.fn();
      watcher.on('started', startedHandler);

      watcher.start();
      watcher.start(); // Second start should be ignored
      expect(startedHandler).toHaveBeenCalledTimes(1);
    });

    it('should emit error when file does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const errorHandler = vi.fn();
      watcher.on('error', errorHandler);

      watcher.start();
      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe('event parsing', () => {
    it('should parse user messages', () => {
      const eventHandler = vi.fn();
      watcher.on('event', eventHandler);

      // Simulate file content - must set up mocks BEFORE starting watcher
      vi.mocked(fs.readFileSync).mockReturnValue('{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"2026-01-01T00:00:00Z"}\n');
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as any);

      watcher.start();

      // The watcher should process the content
      expect(eventHandler).toHaveBeenCalled();
      const event = eventHandler.mock.calls[0][0] as TranscriptEvent;
      expect(event.type).toBe('message');
      expect(event.role).toBe('user');
    });

    it('should parse assistant messages', () => {
      const eventHandler = vi.fn();
      watcher.on('event', eventHandler);

      vi.mocked(fs.readFileSync).mockReturnValue('{"type":"assistant","message":{"role":"assistant","content":"Hi!"},"timestamp":"2026-01-01T00:00:00Z"}\n');
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as any);

      watcher.start();

      expect(eventHandler).toHaveBeenCalled();
      const event = eventHandler.mock.calls[0][0] as TranscriptEvent;
      expect(event.type).toBe('message');
      expect(event.role).toBe('assistant');
    });

    it('should parse tool use events', () => {
      const eventHandler = vi.fn();
      watcher.on('event', eventHandler);

      vi.mocked(fs.readFileSync).mockReturnValue('{"type":"tool_use","name":"bash","input":{"command":"ls"},"timestamp":"2026-01-01T00:00:00Z"}\n');
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as any);

      watcher.start();

      expect(eventHandler).toHaveBeenCalled();
      const event = eventHandler.mock.calls[0][0] as TranscriptEvent;
      expect(event.type).toBe('tool');
      expect(event.toolName).toBe('bash');
    });

    it('should handle malformed JSON gracefully', () => {
      const eventHandler = vi.fn();
      const errorHandler = vi.fn();
      watcher.on('event', eventHandler);

      vi.mocked(fs.readFileSync).mockReturnValue('invalid json\n');
      vi.mocked(fs.statSync).mockReturnValue({ size: 100 } as any);

      watcher.start();

      // Should not emit events for malformed JSON
      expect(eventHandler).not.toHaveBeenCalled();
    });
  });
});
