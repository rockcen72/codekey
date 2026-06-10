import type { UserSession } from '../api/types';

export type AgentClass = 'claude' | 'codex' | 'opencode' | 'unknown';

const AGENT_LABELS: Record<string, string> = {
  'claude-code': 'Claude Code',
  'claude-code-hook': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
};

export function agentLabel(agentType?: string): string {
  return agentType ? (AGENT_LABELS[agentType] || agentType) : 'Agent';
}

export function agentColorClass(agentType?: string): AgentClass {
  if (agentType === 'codex') return 'codex';
  if (agentType === 'opencode') return 'opencode';
  if (agentType === 'claude-code' || agentType === 'claude-code-hook') return 'claude';
  return 'unknown';
}

export function agentChatName(agentType?: string): string {
  if (!agentType) return 'agent';
  return (AGENT_LABELS[agentType] || agentType).toLowerCase();
}

export function sessionTitle(session: UserSession): string {
  return session.metadata.title || session.metadata.claudeSessionId?.slice(0, 8) || session.id.slice(0, 8);
}

export function sessionSubtitle(session: UserSession): string {
  return session.metadata.cwd || session.metadata.runtime || session.agent_type;
}

export function sessionShortId(session: UserSession): string {
  return session.metadata.claudeSessionId?.slice(0, 8) || '';
}

export function statusLabel(status: UserSession['status']): string {
  if (status === 'active') return 'Active';
  if (status === 'paused') return 'Paused';
  return 'Ended';
}

export function collectAgentTabs(sessions: UserSession[]): { key: string; label: string }[] {
  const seen = new Set<string>();
  const tabs = [{ key: 'all', label: 'All' }];
  for (const session of sessions) {
    const key = session.agent_type || session.metadata.runtime || 'unknown';
    if (!seen.has(key)) {
      seen.add(key);
      tabs.push({ key, label: agentLabel(key) });
    }
  }
  return tabs;
}
