import { describe, it, expect } from 'vitest';
import { ResponseMapper } from '../response-mapper.js';

describe('ResponseMapper', () => {
  it('maps approve to y', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'approval');
    expect(mapper.map('evt-1', 'approve')).toBe('y\n');
  });

  it('maps approve with message to y (message ignored for security)', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'approval');
    expect(mapper.map('evt-1', 'approve', 'go ahead')).toBe('y\n');
  });

  it('maps deny to n', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'approval');
    expect(mapper.map('evt-1', 'deny')).toBe('n\n');
  });

  it('returns null for non-matching eventId', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'approval');
    expect(mapper.map('evt-2', 'approve')).toBeNull();
  });

  it('does NOT clear pending on invalid decision', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'approval');
    expect(mapper.map('evt-1', 'pause')).toBeNull();
    expect(mapper.getPending()).toEqual({ eventId: 'evt-1', type: 'approval' });
  });

  it('clears pending on clear()', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'approval');
    mapper.clear();
    expect(mapper.getPending()).toBeNull();
  });

  it('maps question reply to message line', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'question');
    expect(mapper.map('evt-1', 'reply', 'my answer')).toBe('my answer\n');
  });

  it('returns null for question without message', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'question');
    expect(mapper.map('evt-1', 'reply')).toBeNull();
  });

  it('returns null when no pending', () => {
    const mapper = new ResponseMapper();
    expect(mapper.map('evt-1', 'approve')).toBeNull();
  });

  it('clears pending after approve, next call returns null', () => {
    const mapper = new ResponseMapper();
    mapper.setPending('evt-1', 'approval');
    mapper.map('evt-1', 'approve');
    expect(mapper.map('evt-1', 'approve')).toBeNull();
  });
});
