import { Command } from 'commander';

export const pauseCommand = new Command('pause')
  .description('Pause a session')
  .argument('<session-id>', 'Session ID to pause')
  .action(async (sessionId: string) => {
    // TODO: pause agent process
    console.log('Pause not yet implemented', { sessionId });
  });
