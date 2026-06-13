/**
 * .codekeyignore parser — reads user-defined patterns from a
 * `.codekeyignore` file in the workspace root and checks whether
 * a given file path should be blocked from outbound relay.
 *
 * The .codekeyignore format follows the same syntax as .gitignore:
 *   - Lines starting with # are comments
 *   - Blank lines are ignored
 *   - Glob patterns with * and ** are supported
 *   - Negation patterns starting with ! are NOT supported (for now)
 *
 * If no .codekeyignore file exists, only the built-in blocklist
 * is active.
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { matchesAny } from './blocklist.js';

const IGNORE_FILENAME = '.codekeyignore';

export class CodeKeyIgnore {
  private patterns: string[] = [];

  /**
   * @param cwd  Workspace directory to search for .codekeyignore
   */
  constructor(cwd?: string) {
    if (!cwd) return;
    const ignorePath = resolve(cwd, IGNORE_FILENAME);
    if (existsSync(ignorePath)) {
      this.patterns = readFileSync(ignorePath, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith('#'));
    }
  }

  /** Whether any pattern in the ignore file blocks this path. */
  isBlocked(filePath: string): boolean {
    return matchesAny(filePath, this.patterns);
  }

  /** Return the list of loaded patterns (for display/debug). */
  getPatterns(): string[] {
    return [...this.patterns];
  }
}
