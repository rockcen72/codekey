import { describe, expect, it } from 'vitest';
import { formatInputRequiredEvent, parseInputReply, tryFormatInputRequiredEvent } from '../bridge/input-card.js';

describe('input card relay payloads', () => {
  it('formats a Codex requestUserInput selection card for phone relay', () => {
    const card = formatInputRequiredEvent(
      {
        id: 'input-agent',
        method: 'item/tool/requestUserInput',
        params: {
          questions: [
            {
              id: 'agent',
              text: 'Choose an agent',
              options: [
                { label: 'General', value: 'general', description: 'Continue with the general agent' },
                'Reviewer',
              ],
            },
          ],
        },
      },
      'codex',
    );

    expect(card).toEqual({
      type: 'input_required',
      requestId: 'input-agent',
      agent: 'codex',
      risk: 'medium',
      summary: 'Choose an agent',
      questions: [
        {
          id: 'agent',
          text: 'Choose an agent',
          options: [
            { label: 'General', value: 'general', description: 'Continue with the general agent' },
            { label: 'Reviewer', value: 'Reviewer' },
          ],
        },
      ],
    });
  });

  it('maps a plain phone reply to the first input question', () => {
    expect(parseInputReply('general', [{ id: 'agent' }])).toEqual({
      agent: ['general'],
    });
  });

  it('maps a plain phone reply to a default input question when no questions are known', () => {
    expect(parseInputReply('continue', [])).toEqual({
      input: ['continue'],
    });
  });

  it('detects generic agent selection cards but ignores plain text events', () => {
    expect(tryFormatInputRequiredEvent({ summary: 'done' }, 'opencode')).toBeNull();
    expect(tryFormatInputRequiredEvent({ agents: ['builder', 'reviewer'] }, 'opencode')).toMatchObject({
      type: 'input_required',
      agent: 'opencode',
      questions: [{
        id: 'selection',
        options: [
          { label: 'builder', value: 'builder' },
          { label: 'reviewer', value: 'reviewer' },
        ],
      }],
    });
  });
});
