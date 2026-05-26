import { Command } from 'commander';
import { spawn, execSync } from 'node:child_process';

function findClaude(): string | null {
  const candidates = ['npx', 'npx.cmd', 'claude', 'claude.cmd'];
  for (const cmd of candidates) {
    try {
      const which = (process.platform === 'win32'
        ? execSync(`where ${cmd}`, { encoding: 'utf-8', timeout: 2000 }).trim().split('\n')[0]
        : execSync(`which ${cmd}`, { encoding: 'utf-8', timeout: 2000 }).trim());
      if (which) return which;
    } catch { /* not found */ }
  }
  return null;
}

export const claudeCommand = new Command('claude')
  .description('Launch Claude Code')
  .argument('[args...]', 'Arguments to pass to Claude Code')
  .option('--relay <url>', 'Ignored — retained for backward compat with VS Code extension')
  .action(async (args: string[], _options: { relay?: string }) => {
    const claudeBin = findClaude();
    if (!claudeBin) {
      console.error('Claude Code CLI not found. Install it with: npm install -g @anthropic-ai/claude-code');
      process.exit(1);
    }

    // Forward only positional args; --relay is consumed by commander but NOT passed to claude
    const claudeArgs: string[] = [];

    if (claudeBin.endsWith('npx') || claudeBin.endsWith('npx.cmd')) {
      claudeArgs.push('@anthropic-ai/claude-code');
    }

    claudeArgs.push(...args);

    const child = spawn(claudeBin, claudeArgs, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('exit', (code) => {
      process.exit(code ?? 0);
    });

    process.on('SIGINT', () => { child.kill('SIGINT'); });
    process.on('SIGTERM', () => { child.kill('SIGTERM'); });
  });
