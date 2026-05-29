import * as vscode from 'vscode';

const STORAGE_KEY = 'codekey.attachedSessionsV2';

export interface StoredSession {
  deviceId: string;
  claudeSessionId: string;
  title?: string;
  cwd?: string;
  updatedAt: string;
}

export class SessionStore {
  /** Read all stored sessions from globalState. */
  static getAll(context: vscode.ExtensionContext): StoredSession[] {
    return context.globalState.get<StoredSession[]>(STORAGE_KEY, []);
  }

  /** Replace the entire list (used for bulk save after pruning). */
  static async setAll(context: vscode.ExtensionContext, sessions: StoredSession[]): Promise<void> {
    await context.globalState.update(STORAGE_KEY, sessions);
  }

  /** Get sessions for a specific deviceId. */
  static getByDevice(context: vscode.ExtensionContext, deviceId: string): StoredSession[] {
    return SessionStore.getAll(context).filter(s => s.deviceId === deviceId);
  }

  /** Add one session and persist. No-op if duplicate (by deviceId + claudeSessionId). */
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

  /** Remove one session and persist. */
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
}
