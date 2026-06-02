import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const PLUGIN_NAME = 'codekey-telemetry.js';

const OPENCODE_PLUGIN_DIR = path.join(os.homedir(), '.config', 'opencode', 'plugins');

function getPluginPath(): string {
  return path.join(OPENCODE_PLUGIN_DIR, PLUGIN_NAME);
}

function generatePluginCode(bridgeUrl: string): string {
  return `// CodeKey telemetry plugin for OpenCode
// Installed by CodeKey VS Code extension — copies events to CodeKey bridge
// for sidebar status display. Does NOT participate in approval decisions.
const BRIDGE_URL = ${JSON.stringify(bridgeUrl)};

export const CodeKeyTelemetry = async () => {
  return {
    event: async ({ event }) => {
      try {
        await fetch(BRIDGE_URL + '/v1/opencode/telemetry', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: event.type,
            properties: event.properties,
            ts: new Date().toISOString(),
          }),
        });
      } catch { /* bridge not available */ }
    },
  };
};
`;
}

export function isOpenCodePluginInstalled(): boolean {
  return fs.existsSync(getPluginPath());
}

export function installOpenCodePlugin(): void {
  const pluginPath = getPluginPath();
  if (fs.existsSync(pluginPath)) return; // already installed

  fs.mkdirSync(OPENCODE_PLUGIN_DIR, { recursive: true });
  fs.writeFileSync(pluginPath, generatePluginCode('http://127.0.0.1:3001'), 'utf-8');
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
    // Also check common install paths
    const commonPaths = [
      path.join(os.homedir(), '.opencode', 'bin', 'opencode'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'npm', 'opencode'),
      '/usr/local/bin/opencode',
      '/usr/bin/opencode',
    ];
    return commonPaths.some(p => { try { return fs.existsSync(p); } catch { return false; } });
  }
}
