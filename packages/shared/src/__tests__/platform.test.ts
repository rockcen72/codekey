import { describe, it, expect, vi, afterEach } from 'vitest';

const {
  execSyncMock,
  execFileSyncMock,
  existsSyncMock,
} = vi.hoisted(() => ({
  execSyncMock: vi.fn(),
  execFileSyncMock: vi.fn(),
  existsSyncMock: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
}));

vi.mock('node:fs', () => ({
  existsSync: existsSyncMock,
}));

import {
  detectPlatform,
  binaryName,
  whichBinary,
  needsShellForScript,
  discoverOpenCodePort,
  listPidsByPort,
  killPid,
} from '../bridge/platform.js';

afterEach(() => {
  vi.clearAllMocks();
});

// ─── detectPlatform ───

describe('detectPlatform', () => {
  it('returns a valid platform string', () => {
    const p = detectPlatform();
    expect(['win32', 'darwin', 'linux']).toContain(p);
  });
});

// ─── binaryName ───

describe('binaryName', () => {
  it('appends .exe on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(binaryName('claude')).toBe('claude.exe');
    expect(binaryName('codekey')).toBe('codekey.exe');
  });

  it('does not append .exe on darwin', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(binaryName('claude')).toBe('claude');
    expect(binaryName('codekey')).toBe('codekey');
  });

  it('does not append .exe on linux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(binaryName('claude')).toBe('claude');
  });
});

// ─── whichBinary ───

describe('whichBinary', () => {
  it('returns null when binary not found (POSIX)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
    expect(whichBinary('nonexistent-binary')).toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledWith('which', ['nonexistent-binary'], expect.any(Object));
  });

  it('returns path when binary found (POSIX)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execFileSyncMock.mockReturnValue('/usr/local/bin/claude\n');
    existsSyncMock.mockReturnValue(true);
    expect(whichBinary('claude')).toBe('/usr/local/bin/claude');
  });

  it('searches exe → cmd → bat → name on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const calls: string[][] = [];
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      calls.push(args);
      if (args[0] === 'claude.exe') throw new Error('not found');
      if (args[0] === 'claude.cmd') return 'C:\\path\\to\\claude.cmd\n';
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(true);
    expect(whichBinary('claude')).toBe('C:\\path\\to\\claude.cmd');
    expect(calls.map(c => c[0])).toEqual(['claude.exe', 'claude.cmd']);
  });

  it('returns null when all extensions fail on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation(() => { throw new Error('not found'); });
    expect(whichBinary('nope')).toBeNull();
  });

  it('returns .cmd path for npm shim (opencode)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'opencode.exe') throw new Error('not found');
      if (args[0] === 'opencode.cmd') return 'C:\\Users\\test\\AppData\\Roaming\\npm\\opencode.cmd\n';
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(true);
    expect(whichBinary('opencode')).toBe('C:\\Users\\test\\AppData\\Roaming\\npm\\opencode.cmd');
  });

  it('returns first successful lookup when .exe found on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'claude.exe') return 'C:\\bin\\claude.exe\n';
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(true);
    expect(whichBinary('claude')).toBe('C:\\bin\\claude.exe');
  });

  it('handles CRLF multi-line where output on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
      if (args[0] === 'claude.exe') {
        // CRLF multi-line: where may return multiple matches
        return 'C:\\Program Files\\Claude\\claude.exe\r\nC:\\Users\\test\\AppData\\Local\\claude.exe\r\n';
      }
      throw new Error('not found');
    });
    existsSyncMock.mockReturnValue(true);
    // Should pick first result without trailing \r
    expect(whichBinary('claude')).toBe('C:\\Program Files\\Claude\\claude.exe');
  });
});

// ─── needsShellForScript ───

describe('needsShellForScript', () => {
  it('returns true for .cmd on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(needsShellForScript('foo.cmd')).toBe(true);
    expect(needsShellForScript('foo.bat')).toBe(true);
  });

  it('returns false for .exe on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    expect(needsShellForScript('foo.exe')).toBe(false);
    expect(needsShellForScript('foo.js')).toBe(false);
  });

  it('returns false on darwin regardless of suffix', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(needsShellForScript('foo.cmd')).toBe(false);
    expect(needsShellForScript('foo.bat')).toBe(false);
    expect(needsShellForScript('foo')).toBe(false);
  });

  it('returns false on linux regardless of suffix', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(needsShellForScript('foo.cmd')).toBe(false);
  });
});

// ─── discoverOpenCodePort ───

describe('discoverOpenCodePort', () => {
  it('extracts --port from wmic output (win32, node fallback)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    const wmicOutput = 'CommandLine=opencode --port 4096 --host 127.0.0.1\n';
    let callCount = 0;
    execSyncMock.mockImplementation(() => {
      callCount++;
      if (callCount === 1) throw new Error('opencode not found');
      if (callCount === 2) return wmicOutput;
      throw new Error('unexpected');
    });
    expect(discoverOpenCodePort()).toBe(4096);
  });

  it('extracts --port from ps output (POSIX)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    const psOutput = [
      '  501 12345   1   0  10:00AM ?? 0:01.00 node /usr/local/bin/opencode --port 4096',
      '  501 12346   1   0  10:00AM ?? 0:01.00 node /usr/local/bin/opencode --port 4097',
    ].join('\n');
    execSyncMock.mockReturnValue(psOutput);
    expect(discoverOpenCodePort()).toBe(4097);
  });

  it('returns null when no opencode process running', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execSyncMock.mockImplementation(() => { throw new Error('no process'); });
    expect(discoverOpenCodePort()).toBeNull();
  });

  it('handles node ... opencode --port format', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execSyncMock.mockReturnValue(
      '  501 98765   1   0  10:00AM ?? 0:01.00 node /usr/local/bin/opencode --port 4096\n'
    );
    expect(discoverOpenCodePort()).toBe(4096);
  });
});

// ─── listPidsByPort ───

describe('listPidsByPort', () => {
  it('parses netstat output on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execSyncMock.mockReturnValue([
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       12345',
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       12346',
    ].join('\n'));
    const pids = listPidsByPort(3001);
    expect(pids).toEqual(['12345', '12346']);
  });

  it('parses lsof output on darwin', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execSyncMock.mockReturnValue('12345\n12346\n');
    expect(listPidsByPort(3001)).toEqual(['12345', '12346']);
  });

  it('returns empty array on error', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execSyncMock.mockImplementation(() => { throw new Error('command failed'); });
    expect(listPidsByPort(9999)).toEqual([]);
  });

  it('deduplicates PIDs on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    execSyncMock.mockReturnValue([
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       12345',
      '  TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       12345',
    ].join('\n'));
    expect(listPidsByPort(3001)).toEqual(['12345']);
  });
});

// ─── killPid ───

describe('killPid', () => {
  it('calls taskkill on win32', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    killPid('12345');
    expect(execFileSyncMock).toHaveBeenCalledWith('taskkill', ['/F', '/PID', '12345'], expect.any(Object));
  });

  it('calls kill -9 on darwin', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    killPid('12345');
    expect(execFileSyncMock).toHaveBeenCalledWith('kill', ['-9', '12345'], expect.any(Object));
  });

  it('does not throw on error (best effort)', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    execFileSyncMock.mockImplementation(() => { throw new Error('no such process'); });
    expect(() => killPid('99999')).not.toThrow();
  });
});
