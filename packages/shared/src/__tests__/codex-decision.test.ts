import { describe, it, expect } from 'vitest';
import {
  toCodexDecision,
  classifyServerRequest,
  isApprovalMethod,
  isInputMethod,
  isPermissionsMethod,
} from '../bridge/codex-decision.js';

describe('toCodexDecision', () => {
  it('maps approve → accept', () => {
    expect(toCodexDecision('approve')).toBe('accept');
  });

  it('maps deny → decline', () => {
    expect(toCodexDecision('deny')).toBe('decline');
  });

  it('maps pause → cancel', () => {
    expect(toCodexDecision('pause')).toBe('cancel');
  });

  it('throws on reply', () => {
    expect(() => toCodexDecision('reply')).toThrow('use requestUserInput path');
  });
});

describe('classifyServerRequest', () => {
  it('classifies commandExecution as approval', () => {
    expect(classifyServerRequest('item/commandExecution/requestApproval')).toBe('approval');
  });

  it('classifies fileChange as approval', () => {
    expect(classifyServerRequest('item/fileChange/requestApproval')).toBe('approval');
  });

  it('classifies permissions as permissions', () => {
    expect(classifyServerRequest('item/permissions/requestApproval')).toBe('permissions');
  });

  it('classifies requestUserInput as input', () => {
    expect(classifyServerRequest('item/tool/requestUserInput')).toBe('input');
  });

  it('returns null for unknown method', () => {
    expect(classifyServerRequest('unknown/method')).toBeNull();
  });
});

describe('isApprovalMethod', () => {
  it('returns true for commandExecution', () => {
    expect(isApprovalMethod('item/commandExecution/requestApproval')).toBe(true);
  });

  it('returns false for permissions', () => {
    expect(isApprovalMethod('item/permissions/requestApproval')).toBe(false);
  });

  it('returns false for input', () => {
    expect(isApprovalMethod('item/tool/requestUserInput')).toBe(false);
  });
});

describe('isPermissionsMethod', () => {
  it('returns true for permissions', () => {
    expect(isPermissionsMethod('item/permissions/requestApproval')).toBe(true);
  });

  it('returns false for commandExecution', () => {
    expect(isPermissionsMethod('item/commandExecution/requestApproval')).toBe(false);
  });
});

describe('isInputMethod', () => {
  it('returns true for requestUserInput', () => {
    expect(isInputMethod('item/tool/requestUserInput')).toBe(true);
  });

  it('returns false for commandExecution', () => {
    expect(isInputMethod('item/commandExecution/requestApproval')).toBe(false);
  });
});
