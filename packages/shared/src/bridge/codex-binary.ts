import { existsSync } from 'node:fs';
import { sep } from 'node:path';

export interface CodexBinarySearchOptions {
  /** User-configured absolute path from VS Code setting. Skips all other checks if set and valid. */
  configuredPath?: string;
  /** Directories from $PATH env var, split by platform delimiter. */
  pathEntries: string[];
  /** Node process.platform — narrowed to the three supported values. */
  platform: 'win32' | 'linux' | 'darwin';
  /** Path to bundled binary inside the extension. null if unknown/not applicable. */
  bundledPath?: string;
  /** Injectable fs dependency for testability. */
  fs: { existsSync: (p: string) => boolean };
}

const BINARY_NAME: Record<CodexBinarySearchOptions['platform'], string> = {
  win32: 'codex.exe',
  linux: 'codex',
  darwin: 'codex',
};

/**
 * Resolve the Codex binary location using priority order:
 * 1. Explicit configured path (VS Code setting)
 * 2. $PATH search
 * 3. Extension-bundled binary (fallback)
 *
 * Returns null if none found. Pure Node — no VS Code deps, usable in CLI/bridge/server contexts.
 */
export function resolveCodexBinary(opts: CodexBinarySearchOptions): string | null {
  // 1. Explicit configuration
  if (opts.configuredPath) {
    if (opts.fs.existsSync(opts.configuredPath)) return opts.configuredPath;
    // Invalid configured path still terminates search — user expected it to work
    return null;
  }

  const exeName = BINARY_NAME[opts.platform];

  // 2. PATH search
  for (const dir of opts.pathEntries) {
    const candidate = dir.endsWith(sep) ? dir + exeName : dir + sep + exeName;
    if (opts.fs.existsSync(candidate)) return candidate;
  }

  // 3. Extension-bundled fallback
  if (opts.bundledPath && opts.fs.existsSync(opts.bundledPath)) return opts.bundledPath;

  return null;
}
