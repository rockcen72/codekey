import { describe, it, expect } from 'vitest';
import { createEventStreamParser } from '../bridge/sse-parser.js';

describe('SSE Parser', () => {
  it('parses a single event', () => {
    const parser = createEventStreamParser();
    const events = parser.feed('event: permission.asked\ndata: {"id":"r1","sessionID":"s1","permission":"Bash"}\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('permission.asked');
    expect(events[0].properties.id).toBe('r1');
    expect(events[0].properties.permission).toBe('Bash');
  });

  it('parses multiple events in one chunk', () => {
    const parser = createEventStreamParser();
    const events = parser.feed(
      'event: session.created\ndata: {"id":"s1"}\n\n' +
      'event: permission.asked\ndata: {"id":"r1","permission":"Write"}\n\n',
    );
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe('session.created');
    expect(events[1].type).toBe('permission.asked');
    expect(events[1].properties.permission).toBe('Write');
  });

  it('handles partial chunks across multiple feeds', () => {
    const parser = createEventStreamParser();
    const first = parser.feed('event: permission.asked\nda');
    expect(first).toHaveLength(0);
    const second = parser.feed('ta: {"id":"r1"}\n\n');
    expect(second).toHaveLength(1);
    expect(second[0].type).toBe('permission.asked');
  });

  it('ignores empty blocks', () => {
    const parser = createEventStreamParser();
    const events = parser.feed('\n\n\n\n');
    expect(events).toHaveLength(0);
  });

  it('ignores events without data', () => {
    const parser = createEventStreamParser();
    const events = parser.feed('event: permission.asked\n\n');
    expect(events).toHaveLength(0);
  });

  it('wraps non-JSON data as text property', () => {
    const parser = createEventStreamParser();
    const events = parser.feed('event: message.updated\ndata: hello world\n\n');
    expect(events).toHaveLength(1);
    expect(events[0].properties.text).toBe('hello world');
  });
});
