import type { IPty } from 'node-pty';

export interface PtyOptions {
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export class PtyWrapper {
  private pty: IPty | null = null;

  spawn(options: PtyOptions): void {
    // TODO: spawn node-pty process
    console.log('PTY spawn not yet implemented', options);
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
