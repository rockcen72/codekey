import { Command } from 'commander';

export const resumeCommand = new Command('resume')
  .description('Resume a paused session')
  .argument('<session-id>', 'Session ID to resume')
  .action(async (sessionId: string) => {
    // TODO: resume agent process
    console.log('Resume not yet implemented', { sessionId });
  });
