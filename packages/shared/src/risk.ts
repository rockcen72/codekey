import type { RiskLevel } from './types.js';

export interface RiskRule {
  pattern: RegExp;
  level: RiskLevel;
  label: string;
}

const DEFAULT_RULES: RiskRule[] = [
  // low — read-only / safe
  { pattern: /^npm\s+test/i, level: 'low', label: 'Run npm test' },
  { pattern: /^pnpm\s+test/i, level: 'low', label: 'Run pnpm test' },
  { pattern: /^go\s+test/i, level: 'low', label: 'Run Go test' },
  { pattern: /^bun\s+test/i, level: 'low', label: 'Run bun test' },
  { pattern: /^git\s+status/i, level: 'low', label: 'Git status' },
  { pattern: /^ls\b/i, level: 'low', label: 'List files' },
  { pattern: /^cat\b(?!.*\.(env|key|pem|secret))/i, level: 'low', label: 'Read file' },
  { pattern: /^pwd/i, level: 'low', label: 'Print working directory' },
  { pattern: /^which/i, level: 'low', label: 'Locate command' },

  // medium — writes / installs
  { pattern: /^npm\s+(install|add)/i, level: 'medium', label: 'Install npm packages' },
  { pattern: /^pnpm\s+(install|add)/i, level: 'medium', label: 'Install packages' },
  { pattern: /^bun\s+(install|add)/i, level: 'medium', label: 'Install packages' },
  { pattern: /^git\s+commit/i, level: 'medium', label: 'Git commit' },
  { pattern: /^git\s+push\b(?!.*--force)/i, level: 'medium', label: 'Git push' },
  { pattern: /^npx\s/i, level: 'medium', label: 'Run npx command' },
  { pattern: /--write\b/i, level: 'medium', label: 'Write to file' },
  { pattern: /^mkdir/i, level: 'medium', label: 'Create directory' },

  // high — dangerous
  { pattern: /\brm\b/i, level: 'high', label: 'Delete files' },
  { pattern: /git\s+reset\s+--hard/i, level: 'high', label: 'Force reset git' },
  { pattern: /git\s+push\s+--force/i, level: 'high', label: 'Force push git' },
  { pattern: /\bdeploy\b/i, level: 'high', label: 'Deploy' },
  { pattern: /kubectl\s+(apply|delete)/i, level: 'high', label: 'Kubernetes operation' },
  { pattern: /curl\s+\S+\s*\|\s*(sh|bash)/i, level: 'high', label: 'Pipe curl to shell' },
  { pattern: /\.(env|key|pem|secret)/i, level: 'high', label: 'Access sensitive files' },
  { pattern: /\bsudo\b/i, level: 'high', label: 'Sudo command' },

  // critical — prohibited on mobile
  { pattern: /DROP\s+(TABLE|DATABASE)/i, level: 'critical', label: 'Drop database' },
  { pattern: /format\s+(C|D):/i, level: 'critical', label: 'Format disk' },
];

export class RiskEngine {
  private rules: RiskRule[];

  constructor(rules: RiskRule[] = DEFAULT_RULES) {
    this.rules = rules;
  }

  evaluate(command: string): { level: RiskLevel; label: string } {
    const LEVEL_ORDER: RiskLevel[] = ['critical', 'high', 'medium', 'low'];

    for (const level of LEVEL_ORDER) {
      const match = this.rules.find(
        (r) => r.level === level && r.pattern.test(command),
      );
      if (match) {
        return { level: match.level, label: match.label };
      }
    }

    return { level: 'unknown', label: 'Unrecognized command' };
  }

  /** Adapt an OpenCode permission to a command string for risk evaluation. */
  evaluateOpenCodePermission(permission: string, metadata: Record<string, unknown>): { level: RiskLevel; label: string } {
    const command = permissionToCommand(permission, metadata);
    return this.evaluate(command);
  }
}

function permissionToCommand(permission: string, metadata: Record<string, unknown>): string {
  if (metadata.command) return metadata.command as string;
  if (metadata.filePath) return `${permission} ${metadata.filePath}`;
  if (metadata.patch) return `${permission} (patch: ${(metadata.patch as string).slice(0, 50)})`;
  return permission;
}
