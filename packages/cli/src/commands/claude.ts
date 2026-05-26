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
  .description('Launch Claude Code with CodeKey relay integration')
  .argument('[args...]', 'Arguments to pass to Claude Code')
  .option('--relay <url>', 'Relay server URL')
  .action(async (args: string[], options: { relay?: string }) => {
    // Build the claude argv: npx @anthropic-ai/claude -- <args>
    const claudeBin = findClaude();
    if (!claudeBin) {
      console.error('Claude CLI not found. Install it with: npm install -g @anthropic-ai/claude');
      process.exit(1);
    }

    const claudeArgs: string[] = [];

    if (claudeBin.endsWith('npx') || claudeBin.endsWith('npx.cmd')) {
      claudeArgs.push('@anthropic-ai/claude');
    }

    if (options.relay) {
      claudeArgs.push('--relay', options.relay);
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
