import * as vscode from 'vscode';
import { loadCredentials } from '../auth/credentials.js';
import { findCli } from '../cli.js';
import { installHook } from '../hook/installer.js';
import { BridgeStatusService } from '../services/bridge-status.js';
import { log } from '../log.js';
import type { StatusBar } from '../status/bar.js';

const bridgeService = BridgeStatusService.getInstance();

const BRIDGE_URL = 'http://127.0.0.1:3001';

const CLAUDE_CODE_VIEW_TYPE = 'claudeVSCodePanel';

/** Tell the bridge to use this label for the next session registration. */
function setSessionLabel(label: string): void {
  fetch(`${BRIDGE_URL}/v1/session-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, windowId: vscode.env.sessionId }),
  }).catch(() => { /* bridge may not be ready yet */ });
}

/** Find Claude Code webview panel tab and return its label, if visible. */
function getClaudeTabLabel(): string | undefined {
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      if (tab.input instanceof vscode.TabInputWebview &&
          tab.input.viewType === CLAUDE_CODE_VIEW_TYPE) {
        return tab.label;
      }
    }
  }
  return undefined;
}

/**
 * Start watching the Claude Code tab label and sync it to the bridge.
 * The initial label is "Claude Code" and gets updated by the CC extension
 * to reflect the conversation topic (e.g. "分析这段代码").
 * Polls until we get a meaningful label or a max number of attempts.
 */
function startTabLabelSync(): void {
  const seen = new Set<string>();
  let attempts = 0;
  let lastLabel = '';

  const syncLabel = () => {
    const lbl = getClaudeTabLabel();
    if (lbl && lbl !== lastLabel) {
      lastLabel = lbl;
      if (lbl !== 'Claude Code' || !seen.has(lbl)) {
        setSessionLabel(lbl);
      }
      seen.add(lbl);
    }
  };

  // Check every 1.5s for up to 30s, then let tab changes keep us in sync
  syncLabel();
  const timer = setInterval(() => {
    attempts++;
    syncLabel();
    if (attempts >= 20) clearInterval(timer);
  }, 1500);

  // Also catch tab changes (open/close/move) after the poll stops
  vscode.window.tabGroups.onDidChangeTabs(() => {
    if (attempts >= 20) {
      syncLabel(); // one last check
    }
  });
}

/** Match result for terminal name classification */
export type TerminalMatch =
  | { matched: 'codekey'; terminal: vscode.Terminal }   // CodeKey: Claude Code
  | { matched: 'official'; terminal: vscode.Terminal }   // Claude Code
  | { matched: 'numbered'; terminal: vscode.Terminal }   // Claude Code (N)
  | { matched: 'fuzzy'; terminal: vscode.Terminal }      // contains "claude"
  | { matched: null };

/** Classify a terminal by name. */
export function classifyTerminal(term: vscode.Terminal): TerminalMatch {
  const n = term.name;
  if (n === 'CodeKey: Claude Code') return { matched: 'codekey', terminal: term };
  if (n === 'Claude Code') return { matched: 'official', terminal: term };
  if (/^Claude Code \(\d+\)$/.test(n)) return { matched: 'numbered', terminal: term };
  if (/claude/i.test(n)) return { matched: 'fuzzy', terminal: term };
  return { matched: null };
}

/** Priority-ordered strict-match terminal search. */
const STRICT_PRIORITY: TerminalMatch['matched'][] = ['codekey', 'official', 'numbered'];

/**
 * Find existing Claude Code terminal by priority: CodeKey > official > numbered.
 * Fuzzy matches require user confirmation and are excluded here.
 */
export function findExistingClaudeTerminal(): vscode.Terminal | undefined {
  for (const target of STRICT_PRIORITY) {
    for (const t of vscode.window.terminals) {
      if (classifyTerminal(t).matched === target) return t;
    }
  }
  return undefined;
}

const CLAUDE_CODE_EXT_ID = 'anthropic.claude-code';

/**
 * Launch or activate Claude Code.
 *
 * Priority:
 *   1. Claude Code VS Code extension (chat panel) — if installed, open its sidebar
 *   2. Existing Claude Code terminal — bind to it
 *   3. Create a new Claude Code terminal (CLI fallback)
 *
 * Returns a terminal only in modes 2/3 (for phone→agent command relay).
 * Returns undefined in mode 1 (hook system handles approval natively).
 */
export function startClaudeCode(
  _context: vscode.ExtensionContext,
  statusBar: StatusBar,
): vscode.Terminal | undefined {
  const creds = loadCredentials();

  if (!creds || !creds.deviceToken) {
    vscode.window.showWarningMessage(
      'CodeKey is not paired. Run CodeKey: Pair Device first.',
    );
    return;
  }

  // Mode 1: Claude Code extension installed → start bridge, focus tab
  const ccExt = vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID);
  log(`ccExt=${!!ccExt} id=${CLAUDE_CODE_EXT_ID}`);
  if (ccExt) {
    log('startClaude: mode1 — starting bridge');
    const scriptsDir = vscode.Uri.joinPath(_context.extensionUri, 'scripts').fsPath;
    installHook(scriptsDir);
    try {
      bridgeService.start();
      log('startClaude: bridgeService.start() OK');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log(`[CodeKey] bridge start failed: ${msg}`);
    }

    // Open/focus Claude Code tab
    // If a CC editor tab already exists, focus it; otherwise open a new one.
    vscode.commands.executeCommand('claude-vscode.focus');

    // Watch the tab label and sync to bridge — the CC extension updates
    // the panel title to reflect the conversation topic (e.g. user's first message).
    startTabLabelSync();

    statusBar.set('paired');
    return; // no terminal to manage — hooks handle the flow
  }

  // Mode 2: bind to existing Claude Code terminal
  const existing = findExistingClaudeTerminal();
  if (existing) {
    existing.show();
    statusBar.set('paired');
    return existing;
  }

  // Mode 3: no extension, no terminal — launch CLI in a new terminal
  const cliPath = findCli();
  if (!cliPath) {
    const install = 'Install';
    vscode.window.showWarningMessage(
      'CodeKey CLI not found. Install it from npm?',
      install,
    ).then((choice) => {
      if (choice === install) {
        const term = vscode.window.createTerminal({ name: 'Install CodeKey CLI' });
        term.show();
        term.sendText('npm install -g @codekey/cli', true);
      }
    });
    return;
  }

  const terminal = vscode.window.createTerminal({
    name: 'CodeKey: Claude Code',
    shellPath: cliPath,
    shellArgs: ['claude'],
    iconPath: new vscode.ThemeIcon('sparkle'),
  });

  terminal.show();
  statusBar.set('paired');
  return terminal;
}
