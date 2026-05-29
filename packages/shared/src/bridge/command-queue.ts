export interface PendingCommand {
  id: string;
  sessionId: string;
  claudeSessionId?: string;
  cwd?: string;
  text: string;
  source: string;
  timestamp: string;
}

export class CommandQueue {
  private items: PendingCommand[] = [];

  push(cmd: PendingCommand): void {
    this.items.push(cmd);
    if (this.items.length > 50) this.items.shift();
  }

  claim(ids: string[]): PendingCommand[] {
    const idSet = new Set(ids);
    const claimed: PendingCommand[] = [];
    const remaining: PendingCommand[] = [];
    for (const cmd of this.items) {
      if (idSet.has(cmd.id)) claimed.push(cmd);
      else remaining.push(cmd);
    }
    this.items = remaining;
    return claimed;
  }

  peek(): { id: string; sessionId: string; claudeSessionId?: string; cwd?: string; text: string }[] {
    return this.items.map(c => ({
      id: c.id,
      sessionId: c.sessionId,
      claudeSessionId: c.claudeSessionId,
      cwd: c.cwd,
      text: c.text,
    }));
  }

  get length(): number { return this.items.length; }
}
