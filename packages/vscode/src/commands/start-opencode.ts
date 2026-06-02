import * as vscode from 'vscode';
import { randomInt } from 'node:crypto';

const _creating = new Set<string>();
const _terminalsBySession = new Map<string, vscode.Terminal>();

function terminalKey(sessionId?: string): string {
  return sessionId || '__default__';
}

function terminalName(sessionId?: string): string {
  return sessionId ? `opencode-${sessionId.slice(0, 8)}` : 'opencode';
}

function isTerminalAlive(term: vscode.Terminal): boolean {
  return (term as any).exitStatus === undefined;
}

function findOpenCodeTerminal(sessionId?: string): vscode.Terminal | undefined {
  const key = terminalKey(sessionId);
  const tracked = _terminalsBySession.get(key);
  if (tracked) {
    if (isTerminalAlive(tracked)) return tracked;
    _terminalsBySession.delete(key);
  }

  const name = terminalName(sessionId);
  const existing = vscode.window.terminals.find(t => t.name === name);
  if (existing) {
    _terminalsBySession.set(key, existing);
    return existing;
  }
  return undefined;
}

export function hasOpenCodeTerminal(sessionId?: string): boolean {
  return findOpenCodeTerminal(sessionId) !== undefined;
}

export function startOpenCodeTerminal(sessionId?: string): vscode.Terminal | null {
  const key = terminalKey(sessionId);
  const name = terminalName(sessionId);
  const existing = findOpenCodeTerminal(sessionId);
  if (existing) { existing.show(); return existing; }
  if (_creating.has(key)) return null;

  _creating.add(key);
  const port = randomInt(16384, 65536);
  const term = vscode.window.createTerminal({
    name,
    location: { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
    env: { _EXTENSION_OPENCODE_PORT: String(port), OPENCODE_CALLER: 'vscode' },
  });
  _terminalsBySession.set(key, term);
  _creating.delete(key);

  term.show();
  const cmd = sessionId
    ? `opencode --session ${sessionId} --port ${port}`
    : `opencode --port ${port}`;
  term.sendText(cmd);
  return term;
}
