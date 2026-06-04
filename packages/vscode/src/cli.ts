import * as fs from 'node:fs';
import * as path from 'node:path';
import { whichBinary, detectPlatform } from '@codekey/shared/bridge';

const scriptDir = __dirname;

// Walk up from an anchor dir to find node_modules/.bin
function findInParent(anchor: string): string | null {
  const isWin = detectPlatform() === 'win32';
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
  // Try from CWD (workspace root when run from VS Code)
  let result = findInParent(process.cwd());
  if (result) return result;

  // Try from the extension's own directory (monorepo dev)
  result = findInParent(scriptDir);
  if (result) return result;

  // PATH lookup via whichBinary
  const pathResult = whichBinary('codekey');
  if (pathResult) return pathResult;

  return null;
}
