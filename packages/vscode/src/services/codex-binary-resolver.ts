import * as vscode from 'vscode';
import * as path from 'node:path';
import * as process from 'node:process';
import { existsSync } from 'node:fs';
import { resolveCodexBinary } from '@codekey/shared/bridge/codex-binary';

const CODEX_EXTENSION_ID = 'openai.chatgpt';

function detectPlatform(): 'win32' | 'linux' | 'darwin' {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

/** Find the official Codex VS Code extension's bundled binary, if installed. */
function findBundledCodex(): string | null {
  try {
    const ext = vscode.extensions.getExtension(CODEX_EXTENSION_ID);
    if (!ext) return null;
    const platform = detectPlatform();
    const exeName = platform === 'win32' ? 'codex.exe' : 'codex';
    const subdir = platform === 'win32' ? 'windows-x86_64' : platform;
    const candidate = path.join(ext.extensionUri.fsPath, 'bin', subdir, exeName);
    if (existsSync(candidate)) return candidate;
    return null;
  } catch {
    return null;
  }
}

export function resolveCodexBinaryForVSCode(_extensionPath: string): string | null {
  const configuredPath = vscode.workspace.getConfiguration('codekey').get<string>('codexExecutable') || undefined;
  const platform = detectPlatform();
  const exeName = platform === 'win32' ? 'codex.exe' : 'codex';
  const pathEnv = process.env.PATH || '';

  return resolveCodexBinary({
    configuredPath,
    pathEntries: pathEnv.split(path.delimiter).filter(Boolean),
    platform,
    bundledPath: findBundledCodex() ?? undefined,
    fs: { existsSync },
  });
}
