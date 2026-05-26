import { Command } from 'commander';

export const configCommand = new Command('config')
  .description('View or modify local configuration')
  .option('--relay-url <url>', 'Set relay server URL')
  .option('--risk-rules', 'Edit custom risk rules')
  .option('--auto-start', 'Enable/disable auto-start daemon')
  .action(async (options: { relayUrl?: string; riskRules?: boolean; autoStart?: boolean }) => {
    // TODO: read/write config file
    console.log('Config not yet implemented', { options });
  });
