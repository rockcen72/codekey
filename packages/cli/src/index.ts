#!/usr/bin/env node

import { Command } from 'commander';
import { APP_NAME } from '@codekey/shared';
import { loginCommand } from './commands/login.js';
import { listCommand } from './commands/list.js';
import { pauseCommand } from './commands/pause.js';
import { resumeCommand } from './commands/resume.js';
import { configCommand } from './commands/config.js';
import { bridgeCommand } from './commands/bridge.js';
import { claudeCommand } from './commands/claude.js';

const program = new Command();

program
  .name(APP_NAME)
  .description('Remote control for AI coding agents')
  .version('0.1.0');

program.addCommand(loginCommand);
program.addCommand(listCommand);
program.addCommand(pauseCommand);
program.addCommand(resumeCommand);
program.addCommand(configCommand);
program.addCommand(bridgeCommand);
program.addCommand(claudeCommand);

program.parse(process.argv);
