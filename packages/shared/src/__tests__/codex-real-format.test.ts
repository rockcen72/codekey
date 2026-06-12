import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  appendFileSync,
  rmSync,
  readFileSync,
  utimesSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { discoverLocalSessions, loadCodexConversation, normalizeCodexSessionTitle } from '../bridge/codex-local-session-resolver.js';
import { CodexResumeManager } from '../bridge/codex-resume-manager.js';
import { CodexTranscriptWatcher, type TranscriptEvent } from '../bridge/codex-transcript-watcher.js';
import { HistorySharePolicy, setConfig } from '../bridge/history-policy.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * End-to-end tests against the real Codex CLI on-disk format:
 *   ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 *
 * Each transcript starts with a `session_meta` line and continues with
 * `response_item` / `event_msg` envelopes. Validates that the resolver
 * recurses three levels deep and that the watcher normalizes the real
 * payloads instead of dropping them as `unknown`.
 */
describe('Codex real transcript format', () => {
  let tmpHome: string;
  let originalHome: string | undefined;

  const fixturePath = path.join(__dirname, 'fixtures', 'codex-real-transcript.jsonl');
  const fixture = readFileSync(fixturePath, 'utf8');

  beforeEach(() => {
    tmpHome = mkdtempSync(path.join(tmpdir(), 'codekey-codex-real-'));
    originalHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = tmpHome;
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalHome;
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it('marks manual stop so mobile history hides the finished session', async () => {
    const sent: Record<string, any>[] = [];
    const relay = Object.assign(new EventEmitter(), {
      sendRaw(value: string) {
        sent.push(JSON.parse(value));
      },
    });
    const resumedIds = new Set<string>(['server-codex-manual-stop']);
    const manager = new CodexResumeManager(relay as any, resumedIds);

    (manager as any).localToServer.set('codex-local-stop', 'server-codex-manual-stop');
    await manager.stopResume('codex-local-stop');

    expect(sent.find((m) => m.type === 'deactivate_session')?.payload).toEqual({
      sessionId: 'server-codex-manual-stop',
      reason: 'manual_detach',
    });
    expect(resumedIds.has('server-codex-manual-stop')).toBe(false);
  });

  describe('discoverLocalSessions (real three-level layout)', () => {
    it('finds transcripts under sessions/YYYY/MM/DD/', () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout-2026-06-01T15-59-16-019e8231-a3f7-7c43-8dfb-f2107c803690.jsonl');
      writeFileSync(file, fixture, 'utf8');

      const sessions = discoverLocalSessions(20);
      expect(sessions).toHaveLength(1);
      expect(sessions[0].sessionId).toBe('019e8231-a3f7-7c43-8dfb-f2107c803690');
      expect(sessions[0].source).toBe('vscode');
      expect(sessions[0].transcriptPath).toBe(file);
    });

    it('orders newest first across multiple day folders', () => {
      const olderDir = path.join(tmpHome, 'sessions', '2026', '05', '25');
      const newerDir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(olderDir, { recursive: true });
      mkdirSync(newerDir, { recursive: true });

      const olderFile = path.join(olderDir, 'rollout-older.jsonl');
      const newerFile = path.join(newerDir, 'rollout-newer.jsonl');
      writeFileSync(olderFile, fixture.replace('019e8231-a3f7-7c43-8dfb-f2107c803690', 'older-id'), 'utf8');
      writeFileSync(newerFile, fixture.replace('019e8231-a3f7-7c43-8dfb-f2107c803690', 'newer-id'), 'utf8');

      // Force a measurable mtime gap so ordering is deterministic on CI.
      const past = new Date(Date.now() - 60_000);
      utimesSync(olderFile, past, past);

      const sessions = discoverLocalSessions(20);
      expect(sessions.map(s => s.sessionId)).toEqual(['newer-id', 'older-id']);
    });

    it('still picks up flat layouts (sessions/*.jsonl)', () => {
      const dir = path.join(tmpHome, 'sessions');
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'flat.jsonl'), fixture, 'utf8');

      const sessions = discoverLocalSessions(20);
      expect(sessions).toHaveLength(1);
    });

    it('skips Codex subagent transcripts from the local session list', () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout-subagent.jsonl');
      writeFileSync(file, [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'subagent-session', cwd: tmpHome, source: 'vscode' },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T08:00:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'The following is the Codex agent running as a subagent for an internal task.' }],
          },
        }),
      ].join('\n'), 'utf8');

      expect(discoverLocalSessions(20).map(s => s.sessionId)).not.toContain('subagent-session');
    });

    it('keeps normal Codex sessions that mention a subagent later in the transcript', () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout-main-with-subagent.jsonl');
      writeFileSync(file, [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: 'main-session', cwd: tmpHome, source: 'vscode' },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T08:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '修复侧边栏最新会话显示' },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T08:01:00.000Z',
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'The following is the Codex agent running as a subagent for an internal task.' }],
          },
        }),
      ].join('\n'), 'utf8');

      expect(discoverLocalSessions(20)).toEqual(expect.arrayContaining([
        expect.objectContaining({
          sessionId: 'main-session',
          title: '修复侧边栏最新会话显示',
        }),
      ]));
    });

    it('uses the first real user prompt when session_index title is only a session id', () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const sessionId = '019e8231-a3f7-7c43-8dfb-f2107c803690';
      const file = path.join(dir, `rollout-${sessionId}.jsonl`);
      writeFileSync(path.join(tmpHome, 'session_index.jsonl'), JSON.stringify({
        id: sessionId,
        thread_name: sessionId,
        updated_at: '2026-06-01T08:01:00.000Z',
      }) + '\n', 'utf8');
      writeFileSync(file, [
        JSON.stringify({
          type: 'session_meta',
          payload: { id: sessionId, cwd: tmpHome, source: 'vscode' },
        }),
        JSON.stringify({
          timestamp: '2026-06-01T08:00:00.000Z',
          type: 'event_msg',
          payload: { type: 'user_message', message: '修复 Telegram 会话标题' },
        }),
      ].join('\n'), 'utf8');

      expect(discoverLocalSessions(20)[0].title).toBe('修复 Telegram 会话标题');
      expect(normalizeCodexSessionTitle(sessionId)).toBeUndefined();
    });
  });

  describe('CodexTranscriptWatcher (real envelope shapes)', () => {
    function collectEvents(transcriptPath: string): TranscriptEvent[] {
      const events: TranscriptEvent[] = [];
      const w = new CodexTranscriptWatcher({ transcriptPath });
      w.on('event', (e: TranscriptEvent) => events.push(e));
      w.start();
      w.stop();
      return events;
    }

    it('normalises response_item messages, reasoning, and function_call', () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout.jsonl');
      writeFileSync(file, fixture, 'utf8');

      const events = collectEvents(file);

      const messageEvents = events.filter(e => e.type === 'message');
      // user response_item + agent response_item + event_msg user_message + event_msg agent_message
      // (we keep both shapes; they are distinct events the UI may want to dedupe).
      expect(messageEvents.length).toBeGreaterThanOrEqual(2);

      const userMsg = messageEvents.find(e => e.role === 'user');
      expect(userMsg?.content).toContain('Analyze the current project structure');

      const assistantMsg = messageEvents.find(e => e.role === 'assistant');
      expect(assistantMsg?.content).toContain('listing the repository tree');

      const reasoning = events.find(e => e.type === 'reasoning');
      expect(reasoning?.content).toBe('Looking at directory tree first.');

      const tool = events.find(e => e.type === 'tool');
      expect(tool?.toolName).toBe('mcp__codegraph/codegraph_files');
      expect(tool?.toolStatus).toBe('in_progress');

      const usage = events.find(e => e.type === 'usage');
      expect(usage?.usage).toEqual({ inputTokens: 1200, outputTokens: 350, totalTokens: 1550 });

      // session_meta / task_started / task_complete should be unknown, not crash.
      const unknowns = events.filter(e => e.type === 'unknown');
      expect(unknowns.length).toBeGreaterThan(0);
    });

    it('does not re-emit historical lines when new content is appended', async () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout.jsonl');
      writeFileSync(file, fixture, 'utf8');

      const events: TranscriptEvent[] = [];
      const w = new CodexTranscriptWatcher({ transcriptPath: file, pollIntervalMs: 30 });
      w.on('event', (e: TranscriptEvent) => events.push(e));
      w.start();

      const historicalCount = events.length;
      expect(historicalCount).toBeGreaterThan(0);

      // Append one new agent message.
      const newLine = JSON.stringify({
        timestamp: '2026-06-01T08:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Appended after start.' },
      }) + '\n';
      appendFileSync(file, newLine, 'utf8');

      // Give the poller a couple of ticks.
      await new Promise(resolve => setTimeout(resolve, 120));
      w.stop();

      const added = events.length - historicalCount;
      expect(added).toBe(1);
      const last = events[events.length - 1];
      expect(last.type).toBe('message');
      expect(last.role).toBe('assistant');
      expect(last.content).toBe('Appended after start.');
    });

    it('can tail only newly appended lines', async () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout.jsonl');
      writeFileSync(file, fixture, 'utf8');

      const events: TranscriptEvent[] = [];
      const w = new CodexTranscriptWatcher({ transcriptPath: file, pollIntervalMs: 30, processExisting: false });
      w.on('event', (e: TranscriptEvent) => events.push(e));
      w.start();
      expect(events).toHaveLength(0);

      appendFileSync(file, JSON.stringify({
        timestamp: '2026-06-01T08:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Only new content.' },
      }) + '\n', 'utf8');

      await new Promise(resolve => setTimeout(resolve, 120));
      w.stop();

      expect(events).toHaveLength(1);
      expect(events[0].content).toBe('Only new content.');
    });

    it('CodexResumeManager forwards appended assistant transcript output', async () => {
      setConfig('*', { policy: HistorySharePolicy.Recent, updatedAt: Date.now() });
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const sessionId = '019e8231-a3f7-7c43-8dfb-f2107c803690';
      const file = path.join(dir, `rollout-${sessionId}.jsonl`);
      writeFileSync(file, fixture, 'utf8');

      const previousBinary = process.env.CODEX_BINARY_PATH;
      process.env.CODEX_BINARY_PATH = 'codex-test-binary';
      const sent: Record<string, any>[] = [];
      const relay = Object.assign(new EventEmitter(), {
        sendRaw(value: string) {
          const msg = JSON.parse(value);
          sent.push(msg);
          if (msg.type === 'register_session') {
            queueMicrotask(() => {
              relay.emit('session_registered', {
                clientRequestId: msg.payload.clientRequestId,
                sessionId: 'server-codex',
              });
            });
          }
        },
        sendCheckedPayload(p: { raw: string }) { this.sendRaw(p.raw); },
      });
      const manager = new CodexResumeManager(relay as any, new Set());

      try {
        await manager.startResume({
          sessionId,
          cwd: tmpHome,
          title: 'Codex test',
          transcriptPath: file,
          source: 'vscode',
          updatedAt: '2026-06-01T08:00:00.000Z',
          createdAt: '2026-06-01T07:00:00.000Z',
        });
        const beforeCount = sent.length;

        appendFileSync(file, JSON.stringify({
          timestamp: '2026-06-01T08:01:00.000Z',
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Final answer after approval.' },
        }) + '\n', 'utf8');

        await new Promise(resolve => setTimeout(resolve, 1200));

        const taskEvents = sent.slice(beforeCount)
          .filter((m: any) => m.type === 'event' && m.payload?.eventType === 'task_complete');
        expect(taskEvents).toEqual(expect.arrayContaining([
          expect.objectContaining({
            payload: expect.objectContaining({
              data: expect.objectContaining({
                summary: expect.stringContaining('Final answer after approval'),
              }),
            }),
          }),
        ]));
      } finally {
        await manager.stopResume(sessionId);
        if (previousBinary === undefined) delete process.env.CODEX_BINARY_PATH;
        else process.env.CODEX_BINARY_PATH = previousBinary;
      }
    });

    it('handles writes that land mid-line', async () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout.jsonl');
      writeFileSync(file, '', 'utf8');

      const events: TranscriptEvent[] = [];
      const w = new CodexTranscriptWatcher({ transcriptPath: file, pollIntervalMs: 20 });
      w.on('event', (e: TranscriptEvent) => events.push(e));
      w.start();

      const full = JSON.stringify({
        timestamp: '2026-06-01T08:00:00.000Z',
        type: 'event_msg',
        payload: { type: 'agent_message', message: 'Split across two writes.' },
      }) + '\n';

      // First half — no newline yet, watcher must not parse.
      const half = full.slice(0, Math.floor(full.length / 2));
      appendFileSync(file, half, 'utf8');
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(events.filter(e => e.type === 'message')).toHaveLength(0);

      // Second half completes the line.
      appendFileSync(file, full.slice(Math.floor(full.length / 2)), 'utf8');
      await new Promise(resolve => setTimeout(resolve, 80));
      w.stop();

      const messages = events.filter(e => e.type === 'message');
      expect(messages).toHaveLength(1);
      expect(messages[0].content).toBe('Split across two writes.');
    });

    it('CodexResumeManager emits command_started for phone-originated prompts', async () => {
      const sent: Record<string, any>[] = [];
      const relay = Object.assign(new EventEmitter(), {
        sendRaw(value: string) {
          sent.push(JSON.parse(value));
        },
        sendCheckedPayload(p: { raw: string }) { this.sendRaw(p.raw); },
      });
      const manager = new CodexResumeManager(relay as any, new Set());

      (manager as any).sessions.set('server-codex', {
        localSession: {
          sessionId: 'local-codex',
          cwd: tmpHome,
          title: 'Codex test',
          transcriptPath: path.join(tmpHome, 'dummy.jsonl'),
          source: 'vscode',
          updatedAt: '2026-06-01T08:00:00.000Z',
          createdAt: '2026-06-01T07:00:00.000Z',
        },
        runtime: {
          resumeOnce: async () => ({ success: true, exitCode: 0, timedOut: false, stderr: '', events: [] }),
        },
        watcher: null,
        forwardedTextKeys: new Set(),
      });

      await manager.handleCommand('server-codex', '继续排查这个 bug');

      const userPrompt = sent.find((m) => m.type === 'event' && m.payload?.eventType === 'user_prompt');
      const started = sent.find((m) => m.type === 'event' && m.payload?.eventType === 'command_started');

      expect(userPrompt).toBeDefined();
      expect(started).toBeDefined();
      expect(started?.payload?.sessionId).toBe('server-codex');
      expect(started?.payload?.data).toEqual({
        type: 'command_started',
        command: '继续排查这个 bug',
      });
    });
  });

  describe('loadCodexConversation', () => {
    it('loads assistant history from Codex output_text messages', () => {
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const sessionId = '019e8231-a3f7-7c43-8dfb-f2107c803690';
      const file = path.join(dir, `rollout-${sessionId}.jsonl`);
      writeFileSync(file, fixture, 'utf8');

      const entries = loadCodexConversation(sessionId, 5);

      expect(entries).toEqual(expect.arrayContaining([
        expect.objectContaining({
          role: 'assistant',
          text: expect.stringContaining('listing the repository tree'),
        }),
      ]));
    });

    it('forwards assistant history to relay for phone display', async () => {
      setConfig('*', { policy: HistorySharePolicy.Recent, updatedAt: Date.now() });
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout-history.jsonl');
      writeFileSync(file, fixture, 'utf8');

      const sent: Record<string, any>[] = [];
      const relay = Object.assign(new EventEmitter(), {
        sendRaw(value: string) {
          sent.push(JSON.parse(value));
        },
        sendCheckedPayload(p: { raw: string }) { this.sendRaw(p.raw); },
      });
      const manager = new CodexResumeManager(relay as any, new Set());

      await (manager as any)._forwardRecentHistory('server-session', 'dummy-session-id', file);

      expect(sent).toEqual(expect.arrayContaining([
        expect.objectContaining({
          payload: expect.objectContaining({
            eventType: 'task_complete',
            data: expect.objectContaining({
              summary: expect.stringContaining('listing the repository tree'),
            }),
          }),
        }),
      ]));
    });
  });
});
