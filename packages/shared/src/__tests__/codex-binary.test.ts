import { describe, it, expect } from 'vitest';
import { resolveCodexBinary } from '../bridge/codex-binary.js';
import { existsSync } from 'node:fs';

describe('resolveCodexBinary', () => {
  const exists = (p: string) => existsSync(p);

  it('returns configuredPath when it exists', () => {
    const result = resolveCodexBinary({
      configuredPath: process.execPath, // exists
      pathEntries: [],
      platform: 'win32',
      fs: { existsSync: exists },
    });
    expect(result).toBe(process.execPath);
  });

  it('returns null when configuredPath does not exist', () => {
    const result = resolveCodexBinary({
      configuredPath: 'C:/nonexistent/codex.exe',
      pathEntries: [],
      platform: 'win32',
      fs: { existsSync: () => false },
    });
    expect(result).toBeNull();
  });

  it('does not fall through to PATH when configuredPath is set but invalid', () => {
    // configuredPath set but invalid → return null, don't fallback
    const result = resolveCodexBinary({
      configuredPath: 'C:/invalid/path.exe',
      pathEntries: ['C:/valid'],
      platform: 'win32',
      fs: { existsSync: (p) => p === 'C:/valid\\codex.exe' },
    });
    expect(result).toBeNull();
  });

  it('finds binary on PATH', () => {
    const result = resolveCodexBinary({
      pathEntries: ['C:/tools', 'C:/other'],
      platform: 'win32',
      fs: { existsSync: (p) => p === 'C:/tools\\codex.exe' },
    });
    expect(result).toBe('C:/tools\\codex.exe');
  });

  it('uses bundledPath as fallback', () => {
    const result = resolveCodexBinary({
      pathEntries: [],
      platform: 'win32',
      bundledPath: 'C:/ext/bin/codex.exe',
      fs: { existsSync: (p) => p === 'C:/ext/bin/codex.exe' },
    });
    expect(result).toBe('C:/ext/bin/codex.exe');
  });

  it('returns null when nothing found', () => {
    const result = resolveCodexBinary({
      pathEntries: [],
      platform: 'win32',
      fs: { existsSync: () => false },
    });
    expect(result).toBeNull();
  });

  it('uses platform-specific binary name on PATH', () => {
    const calls: string[] = [];
    resolveCodexBinary({
      pathEntries: ['/usr/local/bin'],
      platform: 'linux',
      fs: { existsSync: (p) => { calls.push(p); return false; } },
    });
    // Should search for 'codex' not 'codex.exe' on linux
    const hasCodex = calls.some(c => c.endsWith('codex') && !c.endsWith('.exe'));
    expect(hasCodex).toBe(true);
  });
});
