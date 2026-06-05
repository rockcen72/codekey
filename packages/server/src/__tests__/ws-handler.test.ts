import { describe, expect, it } from 'vitest';
import { isPendingInteractiveEvent } from '../ws/handler.js';

describe('ws event pending classification', () => {
  it('marks input_required events as pending so phone replies can resolve them', () => {
    expect(isPendingInteractiveEvent('approval_required')).toBe(true);
    expect(isPendingInteractiveEvent('input_required')).toBe(true);
    expect(isPendingInteractiveEvent('task_complete')).toBe(false);
  });
});
