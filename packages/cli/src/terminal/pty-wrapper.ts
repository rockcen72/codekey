import { EventEmitter } from 'node:events';
import type { IPty } from 'node-pty';
import pty from 'node-pty';

export interface PtyOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class PtyWrapper extends EventEmitter {
  private pty: IPty | null = null;

  spawn(options: PtyOptions): void {
    const env = { ...process.env, ...options.env } as Record<string, string>;
    this.pty = pty.spawn(options.command, options.args, {
      name: 'xterm-256color',
      cols: 120,
      rows: 40,
      cwd: options.cwd ?? process.cwd(),
      env,
    });

    this.pty.onData((data: string) => {
      this.emit('data', data);
    });

    this.pty.onExit(({ exitCode }: { exitCode: number }) => {
      this.emit('exit', exitCode);
      this.pty = null;
    });
  }

  write(data: string): void {
    this.pty?.write(data);
  }

  resize(cols: number, rows: number): void {
    this.pty?.resize(cols, rows);
  }

  kill(): void {
    this.pty?.kill();
    this.pty = null;
  }

  get isAlive(): boolean {
    return this.pty !== null;
  }
}
