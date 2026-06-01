import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexResumeRuntime, type ResumeEvent } from '../bridge/codex-resume-runtime.js';

// Mock child_process
vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

describe('CodexResumeRuntime', () => {
  let runtime: CodexResumeRuntime;
  let mockProcess: EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn>; killed: boolean };

  beforeEach(() => {
    vi.clearAllMocks();

    mockProcess = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: vi.fn(),
      killed: false,
    });

    vi.mocked(spawn).mockReturnValue(mockProcess as any);

    runtime = new CodexResumeRuntime({
      binaryPath: '/usr/bin/codex',
      cwd: '/workspace',
      timeoutMs: 10000,
    });
  });

  afterEach(() => {
    runtime.removeAllListeners();
  });

  describe('resumeOnce', () => {
    it('should execute resume command and return success result', async () => {
      const resultPromise = runtime.resumeOnce('test-session', 'hello');

      // Simulate stdout with JSONL events
      mockProcess.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"Hi there!"}}\n'));

      // Simulate process exit
      mockProcess.emit('exit', 0);

      const result = await resultPromise;

      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.timedOut).toBe(false);
      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('message');
      expect(result.events[0].role).toBe('assistant');
      expect(result.events[0].content).toBe('Hi there!');
    });

    it('should handle process failure', async () => {
      const resultPromise = runtime.resumeOnce('test-session', 'hello');

      // Simulate stderr
      mockProcess.stderr.emit('data', Buffer.from('Error: session not found\n'));

      // Simulate process exit with error
      mockProcess.emit('exit', 1);

      const result = await resultPromise;

      expect(result.success).toBe(false);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('Error: session not found');
    });

    it('should handle timeout', async () => {
      // Create runtime with very short timeout
      const shortTimeoutRuntime = new CodexResumeRuntime({
        binaryPath: '/usr/bin/codex',
        cwd: '/workspace',
        timeoutMs: 100, // 100ms
      });

      const resultPromise = shortTimeoutRuntime.resumeOnce('test-session', 'hello');

      // Wait for timeout
      await new Promise(resolve => setTimeout(resolve, 200));

      // Simulate kill
      mockProcess.emit('exit', null);

      const result = await resultPromise;

      expect(result.timedOut).toBe(true);
      expect(result.success).toBe(false);
    });

    it('should queue requests when already running', async () => {
      const result1Promise = runtime.resumeOnce('session-1', 'first');
      const result2Promise = runtime.resumeOnce('session-2', 'second');

      // First request should be running
      expect(runtime.isRunning()).toBe(true);
      expect(runtime.getQueueLength()).toBe(1);

      // Complete first request
      mockProcess.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"First"}}\n'));
      mockProcess.emit('exit', 0);

      const result1 = await result1Promise;
      expect(result1.success).toBe(true);

      // Second request should now be running from queue
      // Wait a bit for the queue to process
      await new Promise(resolve => setTimeout(resolve, 100));

      // Complete second request
      mockProcess.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"Second"}}\n'));
      mockProcess.emit('exit', 0);

      const result2 = await result2Promise;
      expect(result2.success).toBe(true);
    });

    it('should parse user messages correctly', async () => {
      const resultPromise = runtime.resumeOnce('test-session', 'hello');

      mockProcess.stdout.emit('data', Buffer.from('{"type":"user","message":{"role":"user","content":"What is 2+2?"}}\n'));
      mockProcess.emit('exit', 0);

      const result = await resultPromise;

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('message');
      expect(result.events[0].role).toBe('user');
      expect(result.events[0].content).toBe('What is 2+2?');
    });

    it('should parse tool use events', async () => {
      const resultPromise = runtime.resumeOnce('test-session', 'hello');

      mockProcess.stdout.emit('data', Buffer.from('{"type":"tool_use","name":"bash","input":{"command":"ls"}}\n'));
      mockProcess.emit('exit', 0);

      const result = await resultPromise;

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('tool');
      expect(result.events[0].toolName).toBe('bash');
      expect(result.events[0].toolStatus).toBe('in_progress');
    });

    it('should parse usage events', async () => {
      const resultPromise = runtime.resumeOnce('test-session', 'hello');

      mockProcess.stdout.emit('data', Buffer.from('{"type":"usage","usage":{"input_tokens":100,"output_tokens":50,"total_tokens":150}}\n'));
      mockProcess.emit('exit', 0);

      const result = await resultPromise;

      expect(result.events).toHaveLength(1);
      expect(result.events[0].type).toBe('usage');
      expect(result.events[0].usage).toEqual({
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      });
    });

    it('should emit events during execution', async () => {
      const events: ResumeEvent[] = [];
      runtime.on('event', (event: ResumeEvent) => events.push(event));

      const resultPromise = runtime.resumeOnce('test-session', 'hello');

      mockProcess.stdout.emit('data', Buffer.from('{"type":"assistant","message":{"role":"assistant","content":"Hello!"}}\n'));
      mockProcess.emit('exit', 0);

      await resultPromise;

      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('Hello!');
    });

    it('should clear queue', () => {
      // Add items to queue by calling resumeOnce multiple times
      runtime.resumeOnce('session-1', 'first');
      runtime.resumeOnce('session-2', 'second');
      runtime.resumeOnce('session-3', 'third');

      expect(runtime.getQueueLength()).toBe(2);

      runtime.clearQueue();
      expect(runtime.getQueueLength()).toBe(0);
    });
  });
});
