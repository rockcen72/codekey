/**
 * Default blocklist — file paths/patterns that are blocked from
 * being sent to the relay by default. Works alongside .codekeyignore
 * which allows users to supplement this list.
 *
 * Each entry is a .gitignore-style glob pattern. Matches against
 * the file paths extracted from approval/command payloads.
 */

export const DEFAULT_BLOCKED_PATTERNS: string[] = [
  // Credential & secret files
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.cer',
  '*.p12',
  '*.pfx',
  'credentials.json',
  'credentials*.json',
  '.netrc',
  '.ssh/**',
  '**/config/tokens*',
  'token*',
  '*.token',

  // Database dumps
  '*.sql',
  '*.db',
  '*.sqlite',
  '*.dump',
  '*.bak',

  // Large binary files
  '*.zip',
  '*.tar.gz',
  '*.tar',
  '*.rar',
  '*.7z',
  '*.exe',
  '*.dll',
  '*.so',
  '*.dylib',
  '*.jar',
  '*.war',

  // IDE & VCS directories
  'node_modules/**',
  '.git/**',
  '__pycache__/**',
  'venv/**',
  '.venv/**',
  '.next/**',
  '.turbo/**',

  // Editor swap files
  '*.swp',
  '*.swo',
  '*.swn',
];

/**
 * Check if a file path matches any pattern in a given list.
 * Uses simple glob matching (supports * and **).
 */
export function matchesAny(filePath: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchGlob(filePath, pattern)) return true;
  }
  return false;
}

/**
 * Simple glob matcher. Supports:
 *   *    — matches any characters except /
 *   **   — matches any characters including /
 *   ?    — matches any single character except /
 *   {a,b}— alternation (comma-separated)
 */
function matchGlob(filePath: string, pattern: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  let pat = pattern.replace(/\\/g, '/');

  // Convert .gitignore-style glob to regex
  let regexStr = '';
  let i = 0;
  while (i < pat.length) {
    const ch = pat[i];
    if (ch === '*' && pat[i + 1] === '*') {
      // ** matches everything
      while (i < pat.length && pat[i] === '*') i++;
      if (pat[i] === '/') i++; // consume trailing /
      regexStr += '.*';
      continue;
    }
    if (ch === '*') {
      regexStr += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      regexStr += '[^/]';
      i++;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexStr += '\\' + ch;
      i++;
      continue;
    }
    regexStr += ch;
    i++;
  }

  const re = new RegExp('^' + regexStr + '$');
  return re.test(p);
}
