import { BaseAdapter, type AdapterOptions } from './base-adapter.js';
import type { AgentType, AgentEventPayload } from '@devtap/shared';

export class GenericPtyAdapter extends BaseAdapter {
  readonly agentType: AgentType = 'generic-pty';
  private outputBuffer: string[] = [];

  constructor(options: AdapterOptions = {}) {
    super(options);
  }

  processOutput(line: string): void {
    this.outputBuffer.push(line);
    if (this.outputBuffer.length > 50) this.outputBuffer.shift();

    const trimmed = line.trim();

    // Basic confirmation detection: y/n, Y/n, [y/N], (y/N), confirm?
    if (/\([Yy]\/[Nn]\)|\[[Yy]\/[Nn]\]|\byes?\s*\/\s*no\b/i.test(trimmed)) {
      this.emitEvent({
        type: 'approval_required',
        action: 'unknown',
        risk: 'unknown',
        summary: 'Input confirmation required',
        contextSnippet: this.outputBuffer.slice(-10).join('\n'),
      });
      return;
    }

    // Question detection
    if (/\?\s*$/.test(trimmed)) {
      this.emitEvent({
        type: 'question',
        question: trimmed,
        contextSnippet: this.outputBuffer.slice(-10).join('\n'),
      });
    }
  }

  processExit(code: number | null): void {
    this.outputBuffer = [];
  }
}
