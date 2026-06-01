import * as vscode from 'vscode';
import * as path from 'node:path';
import * as process from 'node:process';
import { existsSync } from 'node:fs';
import { resolveCodexBinary } from '@codekey/shared/bridge/codex-binary';

function detectPlatform(): 'win32' | 'linux' | 'darwin' {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

export function resolveCodexBinaryForVSCode(extensionPath: string): string | null {
  const configuredPath = vscode.workspace.getConfiguration('codekey').get<string>('codexExecutable') || undefined;
  const platform = detectPlatform();
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex';
  const pathEnv = process.env.PATH || '';

  // Determine platform-specific subdir for bundled binary
  let bundledSubdir: string;
  if (platform === 'win32') bundledSubdir = 'windows-x86_64';
  else if (platform === 'darwin') bundledSubdir = 'darwin';
  else bundledSubdir = 'linux';

  return resolveCodexBinary({
    configuredPath,
    pathEntries: pathEnv.split(path.delimiter).filter(Boolean),
    platform,
    bundledPath: path.join(extensionPath, 'bin', bundledSubdir, exeName),
    fs: { existsSync },
  });
}
