import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

// ── Hoisted Mocks ──────────────────────────────────────────
const { mockedSpawn, mockedResolveCodex, spawnCalls } = vi.hoisted(() => ({
  mockedSpawn: vi.fn(),
  mockedResolveCodex: vi.fn(() => '/path/to/codex'),
  spawnCalls: [] as any[][],
}));

vi.mock('node:child_process', () => ({ spawn: mockedSpawn }));
vi.mock('../bridge/codex-binary.js', () => ({ resolveCodexBinary: mockedResolveCodex }));

// ── Imports ────────────────────────────────────────────────
import { CodexAppServerClient } from '../bridge/codex-app-server-client.js';

// ── Types ──────────────────────────────────────────────────

interface MockProcess {
  stdin: { write: (d: string | Buffer) => boolean };
  stdout: PassThrough;
  stderr: PassThrough;
  emitter: EventEmitter;
  /** Delegates to emitter.on so the client's on('exit') and on('error') calls work. */
  on: (event: string, handler: (...args: any[]) => void) => EventEmitter;
  kill: ReturnType<typeof vi.fn>;
  exitCode: number | null;
  stdinWrites: string[];
}

// ── Helpers ────────────────────────────────────────────────

function createMockProcess(): MockProcess {
  const stdinWrites: string[] = [];
  const emitter = new EventEmitter();
  return {
    stdin: {
      write(data: string | Buffer) {
        const s = data.toString();
        stdinWrites.push(s);
        return true;
      },
    },
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    emitter,
    on: emitter.on.bind(emitter),
    kill: vi.fn(),
    exitCode: null,
    stdinWrites,
  };
}

function pushLine(s: PassThrough, obj: unknown): void {
  s.push(JSON.stringify(obj) + '\n');
}

function lastWrite(writes: string[]): unknown {
  return JSON.parse(writes[writes.length - 1]);
}

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ── Suite ──────────────────────────────────────────────────

describe('CodexAppServerClient', () => {
  let proc: MockProcess;
  let client: CodexAppServerClient;

  let onApproval: ReturnType<typeof vi.fn>;
  let onInput: ReturnType<typeof vi.fn>;
  let onExpired: ReturnType<typeof vi.fn>;

  async function initClient(c: CodexAppServerClient): Promise<void> {
    const p = c.start();
    // At this point start() has run synchronously up to the first await.
    // The initialize request should have been written to stdin.
    expect(proc.stdinWrites.length).toBeGreaterThanOrEqual(1);
    const req = JSON.parse(proc.stdinWrites[0]);
    expect(req.method).toBe('initialize');
    pushLine(proc.stdout, { id: req.id, result: {} });
    // Let readline process the response
    await tick();
    await p;
  }

  beforeEach(() => {
    proc = createMockProcess();
    mockedSpawn.mockReturnValue(proc);
    mockedResolveCodex.mockClear();
    mockedResolveCodex.mockReturnValue('/path/to/codex');

    onApproval = vi.fn();
    onInput = vi.fn();
    onExpired = vi.fn();
    client = new CodexAppServerClient({
      binarySearch: {
        pathEntries: [],
        platform: 'linux',
        fs: { existsSync: () => false },
      },
      cwd: '/test',
      onApproval,
      onInput,
      onExpired,
    });
  });

  afterEach(async () => {
    mockedSpawn.mockReturnValue(createMockProcess());
    if (client) {
      try {
        await client.stop();
      } catch {
        /* ignore */
      }
    }
  });

  // ── quick sanity ────────────────────────────────────────

  describe('mock sanity', () => {
    it('spawn returns the mock process', () => {
      const result = mockedSpawn('x', []);
      expect(result).toBe(proc);
      expect(result.stdin.write).toBeDefined();
    });

    it('write stores data in stdinWrites', () => {
      proc.stdin.write('hello');
      expect(proc.stdinWrites[0]).toBe('hello');
    });
  });

  // ── initial state ──────────────────────────────────────

  describe('initial state', () => {
    it('isRunning is false before start', () => {
      expect(client.isRunning).toBe(false);
    });

    it('currentThreadId is null before start', () => {
      expect(client.currentThreadId).toBeNull();
    });

    it('pendingApprovalCount is 0 before start', () => {
      expect(client.pendingApprovalCount).toBe(0);
    });
  });

  // ── start / init ────────────────────────────────────────

  describe('start / initialize', () => {
    it('start spawns the codex binary and sends initialize request', async () => {
      const p = client.start();
      expect(mockedSpawn).toHaveBeenCalledWith(
        '/path/to/codex',
        ['app-server'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] }),
      );
      expect(proc.stdinWrites.length).toBe(1);
      const req = JSON.parse(proc.stdinWrites[0]);
      expect(req.method).toBe('initialize');
      expect(req.params.clientInfo.name).toBe('codekey');
      // Send response and resolve
      pushLine(proc.stdout, { id: req.id, result: {} });
      await tick();
      await p;
    });

    it('isRunning is true after start', async () => {
      await initClient(client);
      expect(client.isRunning).toBe(true);
    });
  });

  // ── approval flow ──────────────────────────────────────

  describe('approval flow', () => {
    it('responds with accept for approve decision', async () => {
      await initClient(client);

      pushLine(proc.stdout, {
        id: 'req-1',
        method: 'item/commandExecution/requestApproval',
        params: { command: 'ls' },
      });
      await tick();

      expect(onApproval).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'req-1', method: 'item/commandExecution/requestApproval' }),
      );
      expect(client.pendingApprovalCount).toBe(1);

      client.respondApproval('req-1', 'approve');

      expect(lastWrite(proc.stdinWrites)).toEqual({ id: 'req-1', result: { decision: 'accept' } });
    });

    it('responds with decline for deny decision', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'req-1',
        method: 'item/commandExecution/requestApproval',
        params: {},
      });
      await tick();
      client.respondApproval('req-1', 'deny');
      expect(lastWrite(proc.stdinWrites)).toEqual({ id: 'req-1', result: { decision: 'decline' } });
    });

    it('responds with cancel for pause decision', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'req-1',
        method: 'item/commandExecution/requestApproval',
        params: {},
      });
      await tick();
      client.respondApproval('req-1', 'pause');
      expect(lastWrite(proc.stdinWrites)).toEqual({ id: 'req-1', result: { decision: 'cancel' } });
    });

    it('throws when respondApproval is called with reply decision', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'req-1',
        method: 'item/commandExecution/requestApproval',
        params: {},
      });
      await tick();
      expect(() => client.respondApproval('req-1', 'reply')).toThrow('requestUserInput');
    });

    it('silently ignores respondApproval for non-existent request id', async () => {
      await initClient(client);
      const beforeLen = proc.stdinWrites.length;
      client.respondApproval('no-such-id', 'approve');
      expect(proc.stdinWrites.length).toBe(beforeLen);
    });

    it('emits warn when respondApproval is called for a non-approval request', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'req-1',
        method: 'item/tool/requestUserInput',
        params: {},
      });
      await tick();

      const warnSpy = vi.fn();
      client.on('warn', warnSpy);

      const beforeLen = proc.stdinWrites.length;
      client.respondApproval('req-1', 'approve');

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-approval'));
      expect(proc.stdinWrites.length).toBe(beforeLen);
    });

    it('handles fileChange/requestApproval as approval kind', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'req-fc',
        method: 'item/fileChange/requestApproval',
        params: { filePath: '/test/file.ts' },
      });
      await tick();
      expect(client.pendingApprovalCount).toBe(1);
      client.respondApproval('req-fc', 'approve');
      expect(lastWrite(proc.stdinWrites)).toEqual({ id: 'req-fc', result: { decision: 'accept' } });
    });
  });

  // ── input flow ─────────────────────────────────────────

  describe('input flow', () => {
    it('wraps a single-answer question correctly', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'input-1',
        method: 'item/tool/requestUserInput',
        params: { questions: [{ id: 'q1', text: 'Enter command?' }] },
      });
      await tick();

      expect(onInput).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'input-1' }),
      );

      client.respondInput('input-1', { q1: ['ls -la'] });

      expect(lastWrite(proc.stdinWrites)).toEqual({
        id: 'input-1',
        result: { answers: { q1: { answers: ['ls -la'] } } },
      });
    });

    it('wraps multiple questions each with their own answers array', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'input-2',
        method: 'item/tool/requestUserInput',
        params: { questions: [{ id: 'q1' }, { id: 'q2' }] },
      });
      await tick();

      client.respondInput('input-2', {
        q1: ['npm run build'],
        q2: ['--prod', '--verbose'],
      });

      const sent = lastWrite(proc.stdinWrites) as any;
      expect(sent.result.answers).toEqual({
        q1: { answers: ['npm run build'] },
        q2: { answers: ['--prod', '--verbose'] },
      });
    });

    it('silently ignores respondInput for non-existent request id', async () => {
      await initClient(client);
      const beforeLen = proc.stdinWrites.length;
      client.respondInput('no-such-id', { q1: ['test'] });
      expect(proc.stdinWrites.length).toBe(beforeLen);
    });

    it('emits warn when respondInput is called for a non-input request', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'req-1',
        method: 'item/commandExecution/requestApproval',
        params: {},
      });
      await tick();
      const warnSpy = vi.fn();
      client.on('warn', warnSpy);
      const beforeLen = proc.stdinWrites.length;
      client.respondInput('req-1', { q1: ['test'] });
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('non-input'));
      expect(proc.stdinWrites.length).toBe(beforeLen);
    });
  });

  // ── permissions branch ─────────────────────────────────

  describe('permissions branch', () => {
    it('does not call onApproval or onInput callbacks', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'perm-1',
        method: 'item/permissions/requestApproval',
        params: { permissions: [{ type: 'fs_write', path: '.' }] },
      });
      await tick();
      expect(onApproval).not.toHaveBeenCalled();
      expect(onInput).not.toHaveBeenCalled();
    });

    it('sends an immediate decline response with empty permissions', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'perm-1',
        method: 'item/permissions/requestApproval',
        params: {},
      });
      await tick();
      expect(lastWrite(proc.stdinWrites)).toEqual({
        id: 'perm-1',
        result: { permissions: {}, scope: 'turn' },
      });
    });

    it('emits a warn event', async () => {
      await initClient(client);
      const warnSpy = vi.fn();
      client.on('warn', warnSpy);
      pushLine(proc.stdout, {
        id: 'perm-1',
        method: 'item/permissions/requestApproval',
        params: {},
      });
      await tick();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Permissions request'));
    });

    it('does not create a pending entry', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'perm-1',
        method: 'item/permissions/requestApproval',
        params: {},
      });
      await tick();
      expect(client.pendingApprovalCount).toBe(0);
    });
  });

  // ── unknown method ─────────────────────────────────────

  describe('unknown method', () => {
    it('does not call onApproval or onInput', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'x',
        method: 'some/unknown/method',
        params: {},
      });
      await tick();
      expect(onApproval).not.toHaveBeenCalled();
      expect(onInput).not.toHaveBeenCalled();
    });

    it('emits a warn event', async () => {
      await initClient(client);
      const warnSpy = vi.fn();
      client.on('warn', warnSpy);
      pushLine(proc.stdout, {
        id: 'x',
        method: 'some/unknown/method',
        params: {},
      });
      await tick();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Unknown ServerRequest method'));
    });

    it('does not send any response on stdin', async () => {
      await initClient(client);
      const beforeLen = proc.stdinWrites.length;
      pushLine(proc.stdout, {
        id: 'x',
        method: 'some/unknown/method',
        params: {},
      });
      await tick();
      expect(proc.stdinWrites.length).toBe(beforeLen);
    });
  });

  // ── onExit cleanup ─────────────────────────────────────

  describe('onExit cleanup', () => {
    it('expires all pending approvals and calls onExpired', async () => {
      await initClient(client);
      pushLine(proc.stdout, {
        id: 'req-1',
        method: 'item/commandExecution/requestApproval',
        params: {},
      });
      await tick();
      expect(client.pendingApprovalCount).toBe(1);

      proc.emitter.emit('exit', 1);

      expect(client.pendingApprovalCount).toBe(0);
      expect(onExpired).toHaveBeenCalledWith('req-1', expect.stringContaining('exited'));
    });

    it('expires pending entries of both kinds (approval + input)', async () => {
      await initClient(client);
      pushLine(proc.stdout, { id: 'i1', method: 'item/tool/requestUserInput', params: {} });
      pushLine(proc.stdout, { id: 'a1', method: 'item/commandExecution/requestApproval', params: {} });
      await tick();

      proc.emitter.emit('exit', 1);

      expect(onExpired).toHaveBeenCalledTimes(2);
      expect(onExpired).toHaveBeenCalledWith('i1', expect.stringContaining('exited'));
      expect(onExpired).toHaveBeenCalledWith('a1', expect.stringContaining('exited'));
    });

    it('includes exit code in the reason', async () => {
      await initClient(client);
      pushLine(proc.stdout, { id: 'r1', method: 'item/commandExecution/requestApproval', params: {} });
      await tick();

      proc.emitter.emit('exit', 137);

      expect(onExpired).toHaveBeenCalledWith('r1', expect.stringContaining('code=137'));
    });

    it('sets isRunning to false', async () => {
      await initClient(client);
      expect(client.isRunning).toBe(true);
      proc.emitter.emit('exit', 0);
      expect(client.isRunning).toBe(false);
    });

    it('rejects pending outgoing requests', async () => {
      await initClient(client);
      const threadPromise = client.startThread('read-only');
      await tick();
      proc.emitter.emit('exit', 1);
      await expect(threadPromise).rejects.toThrow('exited');
    });

    it('does not auto-restart when stop() was called before exit', async () => {
      await initClient(client);
      pushLine(proc.stdout, { id: 'r1', method: 'item/commandExecution/requestApproval', params: {} });
      await tick();

      await client.stop();

      const errorSpy = vi.fn();
      client.on('error', errorSpy);
      proc.emitter.emit('exit', 0);

      expect(errorSpy).not.toHaveBeenCalled();
    });
  });
});
