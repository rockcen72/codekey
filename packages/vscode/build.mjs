import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

// Clean and recreate dist to avoid stale tsc artifacts (dist/commands/**, dist/services/**, etc.)
const distDir = path.join(root, 'dist');
fs.rmSync(distDir, { recursive: true, force: true });
fs.mkdirSync(distDir, { recursive: true });

// 1. Extension bundle (runs inside VS Code extension host)
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'extension.ts')],
  outfile: path.join(distDir, 'extension.js'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  external: ['vscode'],
  sourcemap: false,
  minify: false,
});

// 1b. Copy admin panel HTML
const adminSrc = path.join(root, '..', 'admin', 'index.html');
if (fs.existsSync(adminSrc)) {
  fs.copyFileSync(adminSrc, path.join(distDir, 'index.html'));
  console.log('  copied admin panel → dist/index.html');
}

// 2. Bridge entry bundle (runs as child process through ELECTRON_RUN_AS_NODE)
// Uses CJS format + .cjs extension because ws (bundled dep) does dynamic require()
// which is not supported in ESM. The .cjs extension is always treated as CJS by Node.js
// regardless of "type": "module" in package.json.
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'bridge-entry.ts')],
  outfile: path.join(distDir, 'bridge-entry.cjs'),
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: [],
  sourcemap: false,
  minify: false,
});
