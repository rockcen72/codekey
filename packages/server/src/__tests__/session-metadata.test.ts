import { describe, expect, it } from 'vitest';
import { applyInheritedSessionTitle } from '../ws/handler.js';

describe('session metadata registration', () => {
  it('documents expected register_session metadata merge behavior', () => {
    const payload = {
      claudeSessionId: 'sid-1',
      windowId: 'window-1',
      metadata: {
        title: '修复多会话',
        cwd: 'F:\\Work\\Codekey',
        runtime: 'claude-code',
        source: 'hook',
      },
    };

    const metadata: Record<string, string> = {};
    if (payload.claudeSessionId) metadata.claudeSessionId = payload.claudeSessionId;
    if (payload.windowId) metadata.windowId = payload.windowId;
    if (payload.metadata && typeof payload.metadata === 'object') {
      for (const [key, value] of Object.entries(payload.metadata)) {
        if (typeof value === 'string' && value.trim()) metadata[key] = value;
      }
    }

    expect(metadata).toEqual({
      claudeSessionId: 'sid-1',
      windowId: 'window-1',
      title: '修复多会话',
      cwd: 'F:\\Work\\Codekey',
      runtime: 'claude-code',
      source: 'hook',
    });
  });

  it('inherits the previous title only when register_session has no title', () => {
    const missingTitle = {
      claudeSessionId: 'ses_abc123',
      runtime: 'opencode',
      source: 'opencode',
    };

    applyInheritedSessionTitle(missingTitle, 'Real OpenCode Title');

    expect(missingTitle).toEqual({
      claudeSessionId: 'ses_abc123',
      runtime: 'opencode',
      source: 'opencode',
      title: 'Real OpenCode Title',
    });

    const explicitTitle = {
      claudeSessionId: 'ses_abc123',
      runtime: 'opencode',
      source: 'opencode',
      title: 'Current Title',
    };

    applyInheritedSessionTitle(explicitTitle, 'Old Title');

    expect(explicitTitle.title).toBe('Current Title');
  });
});
