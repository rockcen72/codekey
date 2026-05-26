import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOOK_SCRIPTS = [
  'claude_code_permission_request.js',
  'claude_code_stop.js',
  'claude_code_notification.js',
];

const HOOKS_DIR = path.join(os.homedir(), '.claude', 'hooks');
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

function getScriptPath(name: string): string {
  return path.join(HOOKS_DIR, name);
}

function makeCommand(scriptName: string): string {
  const scriptPath = getScriptPath(scriptName);
  // Quote script path for Windows paths with spaces
  return `node "${scriptPath}"`;
}

/** Copy hook scripts from extension dir to ~/.claude/hooks/ */
function copyScripts(extensionScriptsDir: string): void {
  fs.mkdirSync(HOOKS_DIR, { recursive: true });
  for (const name of HOOK_SCRIPTS) {
    const src = path.join(extensionScriptsDir, name);
    if (!fs.existsSync(src)) continue;
    const dst = getScriptPath(name);
    fs.copyFileSync(src, dst);
    try { fs.chmodSync(dst, 0o755); } catch { /* Windows may not support chmod */ }
  }
}

/** Remove hook scripts from ~/.claude/hooks/ */
function removeScripts(): void {
  for (const name of HOOK_SCRIPTS) {
    const p = getScriptPath(name);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
}

function buildHookConfig(): Record<string, unknown> {
  return {
    PermissionRequest: [
      { matcher: '', hooks: [{ type: 'command', command: makeCommand('claude_code_permission_request.js') }] },
    ],
    Stop: [
      { matcher: '', hooks: [{ type: 'command', command: makeCommand('claude_code_stop.js') }] },
    ],
    Notification: [
      { matcher: 'idle_prompt', hooks: [{ type: 'command', command: makeCommand('claude_code_notification.js') }] },
    ],
  };
}

/**
 * Merge CodeKey hooks into settings.json.
 * Preserves non-CodeKey hooks; updates entries whose command matches a HOOK_SCRIPTS filename.
 */
function mergeHookConfig(existingSettings: Record<string, unknown>): Record<string, unknown> {
  const existing = (existingSettings.hooks as Record<string, unknown> | undefined) ?? {};
  const codeKeyConfig = buildHookConfig();

  const merged: Record<string, unknown> = {};
  // Process each hook type (PermissionRequest, Stop, Notification)
  for (const [hookType, entries] of Object.entries(codeKeyConfig)) {
    const existingEntries = (existing[hookType] as unknown[]) ?? [];
    // Filter out any existing CodeKey entry (matches by script name in command)
    const otherEntries = existingEntries.filter((e: unknown) => {
      const cmd = (e as { hooks?: { command?: string }[] })?.hooks?.[0]?.command ?? '';
      return !HOOK_SCRIPTS.some(name => cmd.includes(name));
    });
    // Prepend new CodeKey entry, then preserved user entries
    merged[hookType] = [...(entries as unknown[]), ...otherEntries];
  }

  // Copy over any hook types CodeKey doesn't manage
  for (const [key, val] of Object.entries(existing)) {
    if (!merged[key]) merged[key] = val;
  }

  return { ...existingSettings, hooks: merged };
}

export function isHookInstalled(): boolean {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw);
    const hooks = settings.hooks as Record<string, unknown> | undefined;
    if (!hooks) return false;
    return HOOK_SCRIPTS.some(name =>
      JSON.stringify(hooks).includes(name),
    );
  } catch {
    return false;
  }
}

export function getHookPath(): string {
  return HOOKS_DIR;
}

export function installHook(extensionScriptsDir: string): void {
  // 1. Copy scripts to ~/.claude/hooks/
  copyScripts(extensionScriptsDir);

  // 2. Read existing settings.json, merge hooks, write back
  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    settings = JSON.parse(raw);
  } catch {
    // File doesn't exist or invalid JSON — start fresh
  }

  const merged = mergeHookConfig(settings);
  const dir = path.dirname(SETTINGS_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

export function uninstallHook(): void {
  // 1. Remove script files
  removeScripts();

  // 2. Strip CodeKey entries from settings.json
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const settings = JSON.parse(raw);
    const existing = (settings.hooks as Record<string, unknown> | undefined) ?? {};

    const cleaned: Record<string, unknown> = {};
    for (const [hookType, entries] of Object.entries(existing)) {
      const arr = (entries as unknown[]) ?? [];
      const filtered = arr.filter((e: unknown) => {
        const cmd = (e as { hooks?: { command?: string }[] })?.hooks?.[0]?.command ?? '';
        return !HOOK_SCRIPTS.some(name => cmd.includes(name));
      });
      if (filtered.length > 0) cleaned[hookType] = filtered;
    }

    settings.hooks = cleaned;
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch {
    // settings.json doesn't exist or invalid — nothing to clean
  }
}
