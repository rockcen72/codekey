import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PLUGIN_NAME = 'codekey-telemetry.js';

const OPENCODE_PLUGIN_DIR = path.join(os.homedir(), '.config', 'opencode', 'plugins');

function getPluginPath(): string {
  return path.join(OPENCODE_PLUGIN_DIR, PLUGIN_NAME);
}

export function isOpenCodePluginInstalled(): boolean {
  return fs.existsSync(getPluginPath());
}

/** Copy the bundled plugin file to the OpenCode plugins directory. Returns true on success. */
export function installOpenCodePlugin(extensionScriptsDir: string): boolean {
  const pluginPath = getPluginPath();
  if (fs.existsSync(pluginPath)) return true;

  const srcPath = path.join(extensionScriptsDir, PLUGIN_NAME);
  if (!fs.existsSync(srcPath)) {
    throw new Error(`Bundled plugin not found: ${srcPath}`);
  }

  fs.mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });
  fs.copyFileSync(srcPath, pluginPath);
  return true;
}

export function uninstallOpenCodePlugin(): void {
  try {
    if (fs.existsSync(getPluginPath())) fs.unlinkSync(getPluginPath());
  } catch { /* ignore */ }
}

export function isOpenCodeCliInstalled(): boolean {
  try {
    const which = process.platform === 'win32' ? 'where' : 'which';
    const result = require('child_process').execSync(`${which} opencode`, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return !!result.trim();
  } catch {
    const commonPaths = [
      path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'opencode'),
      '/usr/local/bin/opencode',
      '/usr/bin/opencode',
    ];
    return commonPaths.some(p => { try { return fs.existsSync(p); } catch { return false; } });
  }
}
