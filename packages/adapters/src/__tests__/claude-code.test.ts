import { describe, it, expect } from 'vitest';
import { ClaudeCodeAdapter } from '../claude-code.js';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesDir = resolve(__dirname, 'fixtures', 'claude-code');

function loadFixture(name: string): string {
  return readFileSync(resolve(fixturesDir, name), 'utf-8');
}

describe('ClaudeCodeAdapter', () => {
  it('detects npm test approval prompt', () => {
    const adapter = new ClaudeCodeAdapter();
    const events: unknown[] = [];

    adapter.on('agent_event', (e) => events.push(e));
    adapter.processOutput(loadFixture('approval-npm-test.txt'));

    expect(events).toHaveLength(1);
    const event = events[0] as Record<string, unknown>;
    expect(event.type).toBe('approval_required');
    expect((event as { command?: string }).command ?? (event as Record<string, unknown>).action).toBeDefined();
  });

  it('detects git commit approval as medium risk', () => {
    const adapter = new ClaudeCodeAdapter();
    const events: unknown[] = [];

    adapter.on('agent_event', (e) => events.push(e));
    adapter.processOutput(loadFixture('approval-git-commit.txt'));

    expect(events).toHaveLength(1);
    const event = events[0] as { risk?: string };
    expect(event.risk).toBe('medium');
  });

  it('detects question prompts', () => {
    const adapter = new ClaudeCodeAdapter();
    const events: unknown[] = [];

    adapter.on('agent_event', (e) => events.push(e));
    adapter.processOutput(loadFixture('question-how-to.txt'));

    expect(events).toHaveLength(1);
    const event = events[0] as { type?: string };
    expect(event.type).toBe('question');
  });

  it('detects task completion', () => {
    const adapter = new ClaudeCodeAdapter();
    const events: unknown[] = [];

    adapter.on('agent_event', (e) => events.push(e));
    adapter.processOutput(loadFixture('task-complete.txt'));

    expect(events).toHaveLength(1);
    const event = events[0] as { type?: string };
    expect(event.type).toBe('task_complete');
  });

  it('detects errors', () => {
    const adapter = new ClaudeCodeAdapter();
    const events: unknown[] = [];

    adapter.on('agent_event', (e) => events.push(e));
    adapter.processOutput(loadFixture('error-permission.txt'));

    expect(events).toHaveLength(1);
    const event = events[0] as { type?: string };
    expect(event.type).toBe('error');
  });

  it('handles exit code 0 as task complete', () => {
    const adapter = new ClaudeCodeAdapter();
    const events: unknown[] = [];

    adapter.on('agent_event', (e) => events.push(e));
    adapter.processExit(0);

    expect(events).toHaveLength(1);
    const event = events[0] as { type?: string };
    expect(event.type).toBe('task_complete');
  });

  it('handles non-zero exit as error', () => {
    const adapter = new ClaudeCodeAdapter();
    const events: unknown[] = [];

    adapter.on('agent_event', (e) => events.push(e));
    adapter.processExit(1);

    expect(events).toHaveLength(1);
    const event = events[0] as { type?: string };
    expect(event.type).toBe('error');
  });
});
