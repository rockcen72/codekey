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

  it('detects options nested inside params (OpenCode tool_use format)', () => {
    const card = tryFormatInputRequiredEvent({
      id: 'tool-use-1',
      type: 'tool_use',
      name: 'ask_user',
      params: {
        question: 'What next?',
        options: ['1: Continue', '2: Change approach', '3: Custom'],
      },
    }, 'opencode');
    expect(card).not.toBeNull();
    expect(card!.questions).toHaveLength(1);
    expect(card!.questions[0].options).toHaveLength(3);
    expect(card!.questions[0].options![1].label).toBe('2: Change approach');
  });

  it('detects options nested inside input (OpenCode input_required format)', () => {
    const card = tryFormatInputRequiredEvent({
      id: 'part-input',
      type: 'text',
      text: '',
      input_required: true,
      input: {
        question: '请选择',
        options: [
          { label: '继续分析', value: 'continue' },
          { label: '自定义', value: 'custom' },
        ],
      },
    }, 'opencode');
    expect(card).not.toBeNull();
    expect(card!.questions).toHaveLength(1);
    expect(card!.questions[0].options).toHaveLength(2);
    expect(card!.questions[0].options![0].label).toBe('继续分析');
  });

  it('prefers top-level options over nested (no double detection)', () => {
    const card = tryFormatInputRequiredEvent({
      options: ['1: Top'],
      input: { options: ['1: Nested'] },
    }, 'opencode');
    expect(card).not.toBeNull();
    expect(card!.questions[0].options![0].label).toBe('1: Top');
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
