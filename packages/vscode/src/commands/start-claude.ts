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

/** Guard: only install bridge/hook once per window. */
let _bridgeSetupDone = false;
/** Guard: only one label sync + tab watcher per window. */
let _tabWatcherSetup = false;
/** Guard: only one label sync active at a time. */
let _labelSyncActive = false;

/** Tell the bridge to use this label for the next session registration. */
function setSessionLabel(label: string, windowId?: string): void {
  fetch(`${BRIDGE_URL}/v1/session-label`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label, windowId: windowId || vscode.env.sessionId }),
  }).catch(() => { /* bridge may not be ready yet */ });
}

/** Find Claude Code webview panel tab and return its label.
 *  Prefers non-default labels (i.e. not "Claude Code") so that
 *  multi-tab scenarios pick the tab whose title is already a topic summary. */
function getClaudeTabLabel(): string | undefined {
  let fallback: string | undefined;
  for (const group of vscode.window.tabGroups.all) {
    for (const tab of group.tabs) {
      const isWv = tab.input instanceof vscode.TabInputWebview;
      const vt = isWv ? (tab.input as any).viewType : undefined;
      if (isWv && vt && vt.endsWith(CLAUDE_CODE_VIEW_TYPE)) {
        if (tab.label !== 'Claude Code') return tab.label;
        if (!fallback) fallback = tab.label;
      }
    }
  }
  return fallback;
}

/**
 * Start watching the Claude Code tab label and sync it to the bridge.
 * Two-phase polling:
 *   - Phase 1 (30s): poll every 1.5s for fast initial label detection
 *   - Phase 2 (indefinite): poll every 10s to catch later label changes
 * Also syncs on tab change events for instant feedback.
 * Returns a Disposable that cleans up all timers and listeners.
 */
function startTabLabelSync(windowId: string): vscode.Disposable {
  if (_labelSyncActive) return { dispose: () => {} };
  _labelSyncActive = true;
  let lastLabel = '';
  let fastAttempts = 0;

  const syncLabel = () => {
    const lbl = getClaudeTabLabel();
    if (lbl && lbl !== 'Claude Code' && lbl !== lastLabel) {
      lastLabel = lbl;
      log(`syncLabel: sending label "${lbl}" for window ${windowId}`);
      setSessionLabel(lbl);
    }
  };

  // Phase 1: fast poll every 1.5s for 30s
  syncLabel();
  const fastTimer = setInterval(() => {
    fastAttempts++;
    syncLabel();
    if (fastAttempts >= 20) clearInterval(fastTimer);
  }, 1500);

  // Phase 2: slow poll every 10s indefinitely (catches late label changes)
  const slowTimer = setInterval(() => {
    syncLabel();
  }, 10_000);

  // Instant sync on tab changes
  const tabListener = vscode.window.tabGroups.onDidChangeTabs(() => {
    syncLabel();
  });

  return {
    dispose: () => {
      clearInterval(fastTimer);
      clearInterval(slowTimer);
      tabListener.dispose();
    },
  };
}

/** Deactivate the session when the CC tab is closed. */
async function deactivateSessionForWindow(windowId: string): Promise<void> {
  try {
    await fetch(`${BRIDGE_URL}/v1/deactivate-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ windowId }),
    });
  } catch {
    // bridge may already be gone
  }
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
 * Ensure CC tab session sync is active for this window.
 * Idempotent — safe to call from activate() and startClaudeCode().
 *
 * Behavior:
 *   - Always: installs hook + starts bridge (idempotent)
 *   - Starts tab label sync (polls CC tab title and sends to bridge)
 *
 * Note: Does NOT auto-create sessions. Sessions are created on-demand
 * when user clicks Attach in the sidebar or when a hook event fires.
 *
 * Returns true if setup succeeded (CC extension installed + credentials exist).
 */
export function ensureCcSessionSync(context: vscode.ExtensionContext): boolean {
  const creds = loadCredentials();
  if (!creds?.deviceToken) return false;

  const ccExt = vscode.extensions.getExtension(CLAUDE_CODE_EXT_ID);
  if (!ccExt) return false;

  // Install hook + start bridge (once per window)
  if (!_bridgeSetupDone) {
    _bridgeSetupDone = true;
    const scriptsDir = vscode.Uri.joinPath(context.extensionUri, 'scripts').fsPath;
    installHook(scriptsDir);
    bridgeService.ensureStarted();
  }

  // Tab label sync (once per window) — only syncs labels, does NOT auto-create sessions.
  // Sessions are created on-demand when user clicks Attach in the sidebar.
  if (!_tabWatcherSetup) {
    _tabWatcherSetup = true;
    const windowId = vscode.env.sessionId;
    log('ensureCcSessionSync: setting up tab watcher for window', windowId);

    // Clean up old window-level session (from before multi-tab support or session-per-tab)
    deactivateSessionForWindow(windowId);

    // Start label sync — polls for the CC tab label and sends it to the bridge
    // so that when user clicks Attach, the session gets the correct title.
    context.subscriptions.push(startTabLabelSync(windowId));
  }

  return true;
}

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
export async function startClaudeCode(
  _context: vscode.ExtensionContext,
  statusBar: StatusBar,
): Promise<vscode.Terminal | undefined> {
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

    // Ensure bridge + tab watcher are active (tab watcher handles per-tab session lifecycle)
    ensureCcSessionSync(_context);

    // Focus editor first to avoid CC picking up an output channel as @-mention reference
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
    // Open/focus Claude Code tab
    await vscode.commands.executeCommand('claude-vscode.focus');

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
