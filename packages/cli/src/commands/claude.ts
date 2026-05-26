import { Command } from 'commander';

export const claudeCommand = new Command('claude')
  .description('Start a Claude Code session with remote control')
  .argument('[args...]', 'Arguments to pass to Claude Code')
  .option('--daemon', 'Run in background daemon mode')
  .option('--relay <url>', 'Relay server URL')
  .action(async (args: string[], options: { daemon?: boolean; relay?: string }) => {
    // TODO: spawn PTY, attach Claude Code adapter, connect relay
    console.log('Claude Code session not yet implemented', { args, options });
  });
