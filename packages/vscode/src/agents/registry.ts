export interface AgentDef {
  id: string;
  name: string;
  description: string;
  status: 'available' | 'coming_soon';
  mode: 'hook' | 'pty' | 'none';
  sessionAgentTypes: string[];
}

export function getAgents(): AgentDef[] {
  return [
    {
      id: 'claude-code',
      name: 'Claude Code',
      description: 'hook mode - intercept permission requests',
      status: 'available',
      mode: 'hook',
      sessionAgentTypes: ['claude-code', 'claude-code-hook'],
    },
    {
      id: 'codex-cli',
      name: 'Codex CLI',
      description: 'planned adapter',
      status: 'coming_soon',
      mode: 'none',
      sessionAgentTypes: [],
    },
    {
      id: 'opencode',
      name: 'OpenCode',
      description: 'planned adapter',
      status: 'coming_soon',
      mode: 'none',
      sessionAgentTypes: [],
    },
  ];
}
