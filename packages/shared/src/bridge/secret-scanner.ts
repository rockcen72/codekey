/**
 * Secret scanner — detects and redacts sensitive strings in
 * outbound payloads before they leave the local machine.
 *
 * Built-in rules cover common API keys, tokens, private keys,
 * connection strings, and JWTs. The scan runs entirely locally
 * in the bridge process; no payload data is sent externally.
 */

export interface Finding {
  /** Human-readable label (e.g. "OpenAI API Key") */
  name: string;
  /** Severity level for display in the preview panel */
  severity: 'low' | 'medium' | 'high';
  /** The safe replacement used in the redacted payload */
  replacement: string;
  /** Zero-based index of the match start in the original string */
  index: number;
}

export interface Rule {
  name: string;
  severity: 'low' | 'medium' | 'high';
  replacement: string;
  /** Regular expression with global flag. Must not have capture groups
   *  that conflict with String.replaceAll. Use non-capturing groups
   *  ((?:…)) for alternation. */
  pattern: RegExp;
}

const BUILT_IN_RULES: Rule[] = [
  // ── API Keys ──
  {
    name: 'Anthropic API Key',
    severity: 'high',
    replacement: 'sk-ant-***',
    pattern: /sk-ant-[A-Za-z0-9]{20,}/g,
  },
  {
    name: 'OpenAI API Key',
    severity: 'high',
    replacement: 'sk-***',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
  },
  {
    name: 'GitHub Token',
    severity: 'high',
    replacement: 'ghp_***',
    pattern: /ghp_[A-Za-z0-9]{36}/g,
  },
  {
    name: 'GitHub App Token',
    severity: 'high',
    replacement: 'ghs_***',
    pattern: /ghs_[A-Za-z0-9]{36}/g,
  },
  {
    name: 'AWS Access Key ID',
    severity: 'high',
    replacement: 'AKIA***',
    pattern: /AKIA[0-9A-Z]{16}/g,
  },
  {
    name: 'AWS Secret Access Key',
    severity: 'high',
    replacement: 'aws-secret-***',
    pattern: /(?:(?i)AWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?)[A-Za-z0-9\/+]{40}['"]?/g,
  },
  {
    name: 'Google API Key',
    severity: 'high',
    replacement: 'AIza***',
    pattern: /AIza[0-9A-Za-z\-_]{35}/g,
  },

  // ── Authentication tokens ──
  {
    name: 'Bearer Token',
    severity: 'medium',
    replacement: 'Bearer ***',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]{20,}/g,
  },
  {
    name: 'JWT Token',
    severity: 'medium',
    replacement: 'eyJ***.***.***',
    pattern: /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  },
  {
    name: 'Basic Auth',
    severity: 'medium',
    replacement: 'Basic ***',
    pattern: /Basic\s+[A-Za-z0-9+/=]{10,}/g,
  },

  // ── Private keys & certificates ──
  {
    name: 'RSA Private Key',
    severity: 'high',
    replacement: '-----BEGIN RSA PRIVATE KEY-----\n***\n-----END RSA PRIVATE KEY-----',
    pattern: /-----BEGIN\s+RSA\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+RSA\s+PRIVATE\s+KEY-----/g,
  },
  {
    name: 'EC Private Key',
    severity: 'high',
    replacement: '-----BEGIN EC PRIVATE KEY-----\n***\n-----END EC PRIVATE KEY-----',
    pattern: /-----BEGIN\s+EC\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+EC\s+PRIVATE\s+KEY-----/g,
  },
  {
    name: 'OpenSSH Private Key',
    severity: 'high',
    replacement: '-----BEGIN OPENSSH PRIVATE KEY-----\n***\n-----END OPENSSH PRIVATE KEY-----',
    pattern: /-----BEGIN\s+OPENSSH\s+PRIVATE\s+KEY-----[\s\S]*?-----END\s+OPENSSH\s+PRIVATE\s+KEY-----/g,
  },

  // ── Connection strings ──
  {
    name: 'PostgreSQL Connection String',
    severity: 'high',
    replacement: 'postgres://***@***',
    pattern: /postgres(?:ql)?:\/\/[A-Za-z0-9_%]+:[^@\s]+@/g,
  },
  {
    name: 'MySQL Connection String',
    severity: 'high',
    replacement: 'mysql://***@***',
    pattern: /mysql:\/\/[A-Za-z0-9_%]+:[^@\s]+@/g,
  },
  {
    name: 'Redis Connection String',
    severity: 'high',
    replacement: 'redis://***@***',
    pattern: /redis:\/\/[^@\s]+@/g,
  },
  {
    name: 'MongoDB Connection String',
    severity: 'high',
    replacement: 'mongodb://***@***',
    pattern: /mongodb(?:\+srv)?:\/\/[A-Za-z0-9_%]+:[^@\s]+@/g,
  },
];

/**
 * Scan a string for all known secret patterns.
 * Returns an ordered list of findings. Multiple rules may match
 * the same substring; callers should apply redactions sequentially
 * (earlier rules take precedence).
 */
export function scan(input: string, extraRules?: Rule[]): Finding[] {
  const rules = extraRules ? [...BUILT_IN_RULES, ...extraRules] : BUILT_IN_RULES;
  const findings: Finding[] = [];

  for (const rule of rules) {
    rule.pattern.lastIndex = 0; // reset for re-use
    let match: RegExpExecArray | null;
    while ((match = rule.pattern.exec(input)) !== null) {
      findings.push({
        name: rule.name,
        severity: rule.severity,
        replacement: rule.replacement,
        index: match.index,
      });
    }
  }

  // Sort by position so callers can apply redactions left-to-right
  findings.sort((a, b) => a.index - b.index);
  return findings;
}

/**
 * Replace all findings in the input with their safe replacements.
 * Findings are applied from left to right; overlapping matches
 * (where one finding starts before a previous one ends) are skipped
 * to avoid corrupting the output.
 */
export function replace(input: string, findings: Finding[]): string {
  if (findings.length === 0) return input;

  let result = '';
  let cursor = 0;
  let lastEnd = 0;

  for (const f of findings) {
    if (f.index < lastEnd) continue; // skip overlapping
    result += input.slice(cursor, f.index) + f.replacement;
    cursor = f.index + input.slice(f.index).match(/[\s\S]/)![0].length; // advance by 1 char minimum
    // Find actual match end by applying the original pattern
    const raw = input.slice(f.index);
    const rule = BUILT_IN_RULES.find((r) => r.name === f.name);
    if (rule) {
      rule.pattern.lastIndex = 0;
      const m = rule.pattern.exec(raw);
      if (m) {
        cursor = f.index + m[0].length;
        lastEnd = cursor;
      }
    }
  }
  result += input.slice(cursor);
  return result;
}

/**
 * Convenience: scan + replace in one call.
 */
export function scanAndReplace(input: string): { output: string; findings: Finding[] } {
  const findings = scan(input);
  return { output: replace(input, findings), findings };
}
