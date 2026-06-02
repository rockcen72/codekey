import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const HOOK_SCRIPT = 'codex_permission_request.js';

const CODEX_DIR = path.join(os.homedir(), '.codex');
const HOOKS_CONFIG_PATH = path.join(CODEX_DIR, 'hooks.json');

function getScriptPath(): string {
  return path.join(CODEX_DIR, HOOK_SCRIPT);
}

function makeCommand(scriptPath: string): string {
  return `node "${scriptPath}"`;
}

/** Copy hook script from extension dir to ~/.codex/ */
function copyScript(extensionScriptsDir: string): void {
  fs.mkdirSync(CODEX_DIR, { recursive: true });
  const src = path.join(extensionScriptsDir, HOOK_SCRIPT);
  if (!fs.existsSync(src)) return;
  const dst = getScriptPath();
  fs.copyFileSync(src, dst);
  try { fs.chmodSync(dst, 0o755); } catch { /* Windows */ }
}

/** Remove hook script from ~/.codex/ */
function removeScript(): void {
  const p = getScriptPath();
  if (fs.existsSync(p)) fs.unlinkSync(p);
}

function buildHookConfig(): Record<string, unknown> {
  return {
    PermissionRequest: [
      { matcher: '', hooks: [{ type: 'command', command: makeCommand(getScriptPath()) }] },
    ],
  };
}

function mergeHookConfig(existingSettings: Record<string, unknown>): Record<string, unknown> {
  const existing = (existingSettings.hooks as Record<string, unknown> | undefined) ?? {};
  const codeKeyConfig = buildHookConfig();

  const merged: Record<string, unknown> = {};
  for (const [hookType, entries] of Object.entries(codeKeyConfig)) {
    const existingEntries = (existing[hookType] as unknown[]) ?? [];
    const otherEntries = existingEntries.filter((e: unknown) => {
      const cmd = (e as { hooks?: { command?: string }[] })?.hooks?.[0]?.command ?? '';
      return !cmd.includes(HOOK_SCRIPT);
    });
    merged[hookType] = [...(entries as unknown[]), ...otherEntries];
  }
  for (const [key, val] of Object.entries(existing)) {
    if (!merged[key]) merged[key] = val;
  }
  return { ...existingSettings, hooks: merged };
}

export function isCodexHookInstalled(): boolean {
  try {
    // Script file existence is the canonical indicator
    if (fs.existsSync(getScriptPath())) return true;
    // Fallback: check hooks.json config
    const raw = fs.readFileSync(HOOKS_CONFIG_PATH, 'utf-8');
    return raw.includes(HOOK_SCRIPT);
  } catch {
    return false;
  }
}

export function installCodexHook(extensionScriptsDir: string): void {
  copyScript(extensionScriptsDir);

  let settings: Record<string, unknown> = {};
  try {
    const raw = fs.readFileSync(HOOKS_CONFIG_PATH, 'utf-8');
    settings = JSON.parse(raw);
  } catch { /* start fresh */ }

  const merged = mergeHookConfig(settings);
  fs.mkdirSync(path.dirname(HOOKS_CONFIG_PATH), { recursive: true });
  fs.writeFileSync(HOOKS_CONFIG_PATH, JSON.stringify(merged, null, 2), 'utf-8');
}

export function uninstallCodexHook(): void {
  removeScript();
  try {
    const raw = fs.readFileSync(HOOKS_CONFIG_PATH, 'utf-8');
    const settings = JSON.parse(raw);
    const existing = (settings.hooks as Record<string, unknown> | undefined) ?? {};
    const cleaned: Record<string, unknown> = {};
    for (const [hookType, entries] of Object.entries(existing)) {
      const arr = (entries as unknown[]) ?? [];
      const filtered = arr.filter((e: unknown) => {
        const cmd = (e as { hooks?: { command?: string }[] })?.hooks?.[0]?.command ?? '';
        return !cmd.includes(HOOK_SCRIPT);
      });
      if (filtered.length > 0) cleaned[hookType] = filtered;
    }
    settings.hooks = cleaned;
    fs.writeFileSync(HOOKS_CONFIG_PATH, JSON.stringify(settings, null, 2), 'utf-8');
  } catch { /* nothing to clean */ }
}

/** Check if the official Codex VS Code extension (openai.chatgpt) is installed and active. */
export function isCodexExtensionActive(): boolean {
  try {
    const vscode = require('vscode');
    const ext = vscode.extensions.getExtension('openai.chatgpt');
    return ext?.isActive === true;
  } catch { return false; }
}
