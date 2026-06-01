import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';

const scriptDir = __dirname;

// Walk up from an anchor dir to find node_modules/.bin
function findInParent(anchor: string, isWin: boolean): string | null {
  let dir = anchor;
  for (let i = 0; i < 6; i++) { // max 6 levels up
    const binDir = path.join(dir, 'node_modules', '.bin');
    const candidates = isWin
      ? [path.join(binDir, 'codekey.cmd'), path.join(binDir, 'codekey')]
      : [path.join(binDir, 'codekey'), path.join(binDir, 'codekey.cmd')];
    // npm workspaces: @codekey/cli → packages/cli (symlink follows automatically)
  candidates.push(path.join(dir, 'node_modules', '@codekey', 'cli', 'dist', 'index.js'));
  candidates.push(path.join(dir, 'node_modules', 'codekey', 'cli', 'dist', 'index.js'));
    for (const p of candidates) {
      try { if (fs.existsSync(p)) return p; } catch { /* skip */ }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function findCli(): string | null {
  const isWin = process.platform === 'win32';

  // Try from CWD (workspace root when run from VS Code)
  let result = findInParent(process.cwd(), isWin);
  if (result) return result;

  // Try from the extension's own directory (monorepo dev)
  result = findInParent(scriptDir, isWin);
  if (result) return result;

  // PATH lookup
  try {
    const pathResult = execSync(
      isWin ? 'where codekey' : 'which codekey',
      { encoding: 'utf-8', timeout: 3000 },
    ).trim().split('\n')[0];
    if (pathResult) return pathResult;
  } catch { /* not in PATH */ }

  return null;
}
