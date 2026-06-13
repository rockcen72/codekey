import { describe, it, expect } from 'vitest';
import { scan, replace, scanAndReplace } from '../bridge/secret-scanner.js';

describe('secret-scanner', () => {
  describe('scan', () => {
    it('detects an Anthropic API key', () => {
      const input = 'export ANTHROPIC_API_KEY=sk-ant-ABCDEFGHIJKLMNOPQRST';
      const findings = scan(input);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(findings[0].name).toBe('Anthropic API Key');
    });

    it('detects an OpenAI API key', () => {
      const input = 'openai_key=sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const findings = scan(input);
      expect(findings.some((f) => f.name === 'OpenAI API Key')).toBe(true);
    });

    it('detects a GitHub token', () => {
      const input = 'token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij';
      const findings = scan(input);
      expect(findings.some((f) => f.name === 'GitHub Token')).toBe(true);
    });

    it('detects an AWS access key', () => {
      const input = 'aws_key=AKIAIOSFODNN7EXAMPLE';
      const findings = scan(input);
      expect(findings.some((f) => f.name === 'AWS Access Key ID')).toBe(true);
    });

    it('detects a JWT token', () => {
      const input = 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNqP2g3sHUl2kZ7T3e4v';
      const findings = scan(input);
      expect(findings.some((f) => f.name === 'JWT Token')).toBe(true);
    });

    it('detects a PostgreSQL connection string', () => {
      const input = 'postgres://user:pass123@localhost:5432/db';
      const findings = scan(input);
      expect(findings.some((f) => f.name === 'PostgreSQL Connection String')).toBe(true);
    });

    it('detects a private RSA key block', () => {
      const input = 'key=' + '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
      const findings = scan(input);
      expect(findings.some((f) => f.name === 'RSA Private Key')).toBe(true);
    });

    it('returns empty for clean input', () => {
      const input = 'echo hello world';
      const findings = scan(input);
      expect(findings.length).toBe(0);
    });

    it('returns empty for short random strings', () => {
      const input = 'curl https://example.com/api -H "Authorization: Basic abcd"';
      const findings = scan(input);
      // Basic auth requires 10+ chars; "abcd" is too short
      expect(findings.every((f) => f.name !== 'Basic Auth')).toBe(true);
    });
  });

  describe('replace', () => {
    it('redacts a single API key', () => {
      const input = 'export KEY=sk-ant-ABCDEFGHIJKLMNOPQRST';
      const { output, findings } = scanAndReplace(input);
      expect(findings.length).toBeGreaterThanOrEqual(1);
      expect(output).not.toContain('sk-ant-ABCDEFGHIJKLMNOPQRST');
      expect(output).toContain('sk-ant-***');
    });

    it('redacts multiple different secrets', () => {
      const input = [
        'aws=AKIAIOSFODNN7EXAMPLE',
        ' github=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
      ].join('\n');
      const { output, findings } = scanAndReplace(input);
      expect(findings.length).toBeGreaterThanOrEqual(2);
      expect(output).not.toContain('AKIAIOSFODNN7');
      expect(output).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij');
    });

    it('preserves non-sensitive text around secrets', () => {
      const input = 'echo connecting to host=db.example.com port=5432';
      const { output } = scanAndReplace(input);
      expect(output).toBe(input);
    });

    it('handles empty input', () => {
      const { output, findings } = scanAndReplace('');
      expect(output).toBe('');
      expect(findings.length).toBe(0);
    });
  });
});
