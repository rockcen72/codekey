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
 * Uses gitignore-inspired matching (subset only):
 *   - Patterns without `/` match against the basename
 *   - Patterns with `/` match against the full relative path
 *   - `*` matches any chars except `/`
 *   - `**` matches any chars including `/`
 *   - `?` matches any single char except `/`
 *
 * Not supported: ! negation, rooted (/foo) patterns, directory-only (foo/) patterns.
 * This subset is sufficient for CodeKey's default blocklist and .codekeyignore;
 * full gitignore compatibility is not a goal.
 */
export function matchesAny(filePath: string, patterns: string[]): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  for (const pattern of patterns) {
    // .gitignore convention: pattern without / matches basename only
    if (!pattern.includes('/')) {
      const basename = normalized.split('/').pop() ?? normalized;
      if (globMatch(basename, pattern)) return true;
      // Also try **/ prepended for paths like secret/*.key
      if (globMatch(normalized, `**/${pattern}`)) return true;
    } else {
      // Pattern contains / — match against full path
      if (globMatch(normalized, pattern)) return true;
      // Also try **/ prepended so nested paths match
      if (!pattern.startsWith('**/')) {
        if (globMatch(normalized, `**/${pattern}`)) return true;
      }
    }
  }
  return false;
}

/** Lightweight glob matcher — converts a glob to a regex. */
function globMatch(filePath: string, pattern: string): boolean {
  if (filePath === pattern) return true;
  let regex = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      while (i < pattern.length && pattern[i] === '*') i++;
      if (pattern[i] === '/') i++;
      regex += '[\\s\\S]*';
      continue;
    }
    if (ch === '*') {
      regex += '[^/]*';
      i++;
      continue;
    }
    if (ch === '?') {
      regex += '[^/]';
      i++;
      continue;
    }
    regex += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i++;
  }
  try {
    return new RegExp('^' + regex + '$').test(filePath);
  } catch {
    return false;
  }
}

