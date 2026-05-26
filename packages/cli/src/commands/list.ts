import { Command } from 'commander';

export const listCommand = new Command('list')
  .description('List active sessions')
  .action(async () => {
    // TODO: read local session state
    console.log('List sessions not yet implemented');
  });
