import { describe, it, expect } from 'vitest';
import { RiskEngine } from '../risk.js';

describe('RiskEngine', () => {
  const engine = new RiskEngine();

  it('classifies npm test as low risk', () => {
    const result = engine.evaluate('npm test');
    expect(result.level).toBe('low');
  });

  it('classifies git commit as medium risk', () => {
    const result = engine.evaluate('git commit -m "fix"');
    expect(result.level).toBe('medium');
  });

  it('classifies rm as high risk', () => {
    const result = engine.evaluate('rm -rf /data');
    expect(result.level).toBe('high');
  });

  it('classifies DROP TABLE as critical', () => {
    const result = engine.evaluate('DROP TABLE users');
    expect(result.level).toBe('critical');
  });

  it('returns unknown for unrecognized commands', () => {
    const result = engine.evaluate('echo hello');
    expect(result.level).toBe('unknown');
  });

  it('matches high risk before medium when both match', () => {
    const result = engine.evaluate('sudo npm test');
    expect(result.level).toBe('high');
  });

  it('supports custom rules via constructor', () => {
    const custom = new RiskEngine([
      { pattern: /^my-tool/i, level: 'low', label: 'Safe tool' },
    ]);
    const result = custom.evaluate('my-tool deploy');
    expect(result.level).toBe('low');
    expect(result.label).toBe('Safe tool');
  });

  describe('evaluateOpenCodePermission', () => {
    it('extracts command from metadata.command', () => {
      const result = engine.evaluateOpenCodePermission('Bash', { command: 'rm -rf /' });
      expect(result.level).toBe('high');
    });

    it('constructs command from filePath', () => {
      const result = engine.evaluateOpenCodePermission('Write', { filePath: '.env' });
      expect(result.level).toBe('high');
    });

    it('constructs command from patch metadata', () => {
      // The constructed command contains "patch:" prefix, falling through to unknown
      const result = engine.evaluateOpenCodePermission('Edit', { patch: '--- a/foo\n+++ b/foo\n' });
      expect(result.level).toBe('unknown');
    });

    it('falls back to permission name', () => {
      const result = engine.evaluateOpenCodePermission('Bash', {});
      expect(result.level).toBe('unknown');
    });
  });
});
