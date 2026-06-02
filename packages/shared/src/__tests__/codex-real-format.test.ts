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
import { discoverLocalSessions, loadCodexConversation } from '../bridge/codex-local-session-resolver.js';
import { CodexResumeManager } from '../bridge/codex-resume-manager.js';
import { CodexTranscriptWatcher, type TranscriptEvent } from '../bridge/codex-transcript-watcher.js';

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
      const dir = path.join(tmpHome, 'sessions', '2026', '06', '01');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'rollout-history.jsonl');
      writeFileSync(file, fixture, 'utf8');

      const sent: Record<string, any>[] = [];
      const relay = Object.assign(new EventEmitter(), {
        sendRaw(value: string) {
          sent.push(JSON.parse(value));
        },
      });
      const manager = new CodexResumeManager(relay as any, new Set());

      await (manager as any)._forwardRecentHistory('server-session', file);

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
