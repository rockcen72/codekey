#!/usr/bin/env node

import { Command } from 'commander';
import { APP_NAME } from '@devtap/shared';
import { loginCommand } from './commands/login.js';
import { claudeCommand } from './commands/claude.js';
import { listCommand } from './commands/list.js';
import { pauseCommand } from './commands/pause.js';
import { resumeCommand } from './commands/resume.js';
import { configCommand } from './commands/config.js';

const program = new Command();

program
  .name(APP_NAME)
  .description('Remote control for AI coding agents')
  .version('0.1.0');

program.addCommand(loginCommand);
program.addCommand(claudeCommand);
program.addCommand(listCommand);
program.addCommand(pauseCommand);
program.addCommand(resumeCommand);
program.addCommand(configCommand);

program.parse(process.argv);
