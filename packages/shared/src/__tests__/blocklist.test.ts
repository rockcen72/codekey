import { describe, it, expect } from 'vitest';
import { matchesAny, DEFAULT_BLOCKED_PATTERNS } from '../bridge/blocklist.js';

describe('blocklist - matchesAny', () => {
  it('matches literal .env by basename', () => {
    expect(matchesAny('.env', ['.env'])).toBe(true);
  });

  it('matches .env in subdirectory', () => {
    expect(matchesAny('/repo/.env', ['.env'])).toBe(true);
  });

  it('matches .env in Windows path', () => {
    expect(matchesAny('F:\\repo\\.env', ['.env'])).toBe(true);
  });

  it('matches development .env.local', () => {
    expect(matchesAny('/repo/.env.local', ['.env.*'])).toBe(true);
  });

  it('matches *.pem in any directory', () => {
    expect(matchesAny('secret/key.pem', ['*.pem'])).toBe(true);
  });

  it('matches node_modules deep path', () => {
    expect(matchesAny('project/node_modules/pkg/file.js', ['node_modules/**'])).toBe(true);
  });

  it('matches .ssh directory', () => {
    expect(matchesAny('/home/user/.ssh/id_rsa', ['.ssh/**'])).toBe(true);
  });

  it('does not match normal source files', () => {
    expect(matchesAny('src/index.ts', ['.env', '*.pem', 'node_modules/**'])).toBe(false);
  });

  it('matches against DEFAULT_BLOCKED_PATTERNS for common paths', () => {
    const cases = [
      '/project/.env',
      'config/.env.production',
      'certs/server.pem',
      'keys/private.key',
      'project/credentials.json',
      '.netrc',
      'secret/dump.sql',
      'node_modules/lodash/index.js',
      '.git/config',
      '__pycache__/cache.pyc',
    ];
    for (const c of cases) {
      expect(matchesAny(c, DEFAULT_BLOCKED_PATTERNS)).toBe(true);
    }
  });

  it('does not match non-blocked files', () => {
    const safe = [
      'src/index.ts',
      'README.md',
      'package.json',
      'docs/guide.md',
    ];
    for (const s of safe) {
      expect(matchesAny(s, DEFAULT_BLOCKED_PATTERNS)).toBe(false);
    }
  });
});
