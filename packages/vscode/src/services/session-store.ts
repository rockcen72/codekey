import * as vscode from 'vscode';

const STORAGE_KEY = 'codekey.attachedSessionsV2';
const OC_STORAGE_KEY = 'codekey.opencodeSessions';

export interface StoredSession {
  deviceId: string;
  claudeSessionId: string;
  title?: string;
  cwd?: string;
  updatedAt: string;
  agentType?: string;
}

export class SessionStore {
  static getAll(context: vscode.ExtensionContext): StoredSession[] {
    return context.globalState.get<StoredSession[]>(STORAGE_KEY, []);
  }

  static async setAll(context: vscode.ExtensionContext, sessions: StoredSession[]): Promise<void> {
    await context.globalState.update(STORAGE_KEY, sessions);
  }

  static getByDevice(context: vscode.ExtensionContext, deviceId: string): StoredSession[] {
    return SessionStore.getAll(context).filter(s => s.deviceId === deviceId);
  }

  static async add(
    context: vscode.ExtensionContext,
    deviceId: string,
    claudeSessionId: string,
    metadata?: { title?: string; cwd?: string },
  ): Promise<void> {
    const sessions = SessionStore.getAll(context);
    if (sessions.some(s => s.deviceId === deviceId && s.claudeSessionId === claudeSessionId)) return;
    sessions.push({
      deviceId,
      claudeSessionId,
      title: metadata?.title,
      cwd: metadata?.cwd,
      updatedAt: new Date().toISOString(),
    });
    await context.globalState.update(STORAGE_KEY, sessions);
  }

  static async remove(
    context: vscode.ExtensionContext,
    deviceId: string,
    claudeSessionId: string,
  ): Promise<void> {
    const sessions = SessionStore.getAll(context).filter(
      s => !(s.deviceId === deviceId && s.claudeSessionId === claudeSessionId),
    );
    await context.globalState.update(STORAGE_KEY, sessions);
  }

  // ── OpenCode sessions ──────────────────────────────────────

  static getOpenCodeByDevice(context: vscode.ExtensionContext, deviceId: string): StoredSession[] {
    const all = context.globalState.get<StoredSession[]>(OC_STORAGE_KEY, []);
    return all.filter(s => s.deviceId === deviceId);
  }

  static async addOpenCode(
    context: vscode.ExtensionContext,
    deviceId: string,
    sessionId: string,
    metadata?: { title?: string; cwd?: string },
  ): Promise<void> {
    const all = context.globalState.get<StoredSession[]>(OC_STORAGE_KEY, []);
    if (all.some(s => s.deviceId === deviceId && s.claudeSessionId === sessionId)) return;
    all.push({
      deviceId,
      claudeSessionId: sessionId,
      title: metadata?.title,
      cwd: metadata?.cwd,
      updatedAt: new Date().toISOString(),
      agentType: 'opencode',
    });
    await context.globalState.update(OC_STORAGE_KEY, all);
  }

  static async removeOpenCode(
    context: vscode.ExtensionContext,
    deviceId: string,
    sessionId: string,
  ): Promise<void> {
    const all = context.globalState.get<StoredSession[]>(OC_STORAGE_KEY, []);
    await context.globalState.update(
      OC_STORAGE_KEY,
      all.filter(s => !(s.deviceId === deviceId && s.claudeSessionId === sessionId)),
    );
  }
}
