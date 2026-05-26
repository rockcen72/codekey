import { randomUUID } from 'node:crypto';
import type { SessionStatus } from '@codekey/shared';

interface SessionState {
  id: string;
  status: SessionStatus;
  startedAt: Date;
  lastActiveAt: Date;
}

export class SessionManager {
  private sessions = new Map<string, SessionState>();

  create(agentType: string): SessionState {
    const session: SessionState = {
      id: randomUUID(),
      status: 'active',
      startedAt: new Date(),
      lastActiveAt: new Date(),
    };
    this.sessions.set(session.id, session);
    return session;
  }

  get(id: string): SessionState | undefined {
    return this.sessions.get(id);
  }

  updateStatus(id: string, status: SessionStatus): void {
    const session = this.sessions.get(id);
    if (session) {
      session.status = status;
      session.lastActiveAt = new Date();
    }
  }

  getAll(): SessionState[] {
    return Array.from(this.sessions.values());
  }

  listActive(): SessionState[] {
    return this.getAll().filter((s) =>
      ['active', 'awaiting_approval', 'awaiting_reply', 'paused'].includes(s.status),
    );
  }

  remove(id: string): void {
    this.sessions.delete(id);
  }
}
