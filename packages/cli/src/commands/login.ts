import { Command } from 'commander';

export const loginCommand = new Command('login')
  .description('Display QR code to bind with WeChat mini program')
  .action(async () => {
    // TODO: generate pairing code, render QR code, wait for binding
    console.log('Login flow not yet implemented');
  });
