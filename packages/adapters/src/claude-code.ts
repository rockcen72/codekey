import { BaseAdapter, type AdapterOptions } from './base-adapter.js';
import { RiskEngine } from './risk-engine.js';
import { AnsiStripper } from './ansi-strip.js';
import { ScreenBuffer } from './screen-buffer.js';
import type { AgentType, AgentEventPayload, RiskLevel } from '@devtap/shared';

type ClaudeState = 'idle' | 'awaiting_approval' | 'awaiting_reply' | 'running';

export class ClaudeCodeAdapter extends BaseAdapter {
  readonly agentType: AgentType = 'claude-code';
  private state: ClaudeState = 'idle';
  private riskEngine: RiskEngine;
  private ansiStripper: AnsiStripper;
  private screenBuffer: ScreenBuffer;
  private buffer: string[] = [];

  constructor(options: AdapterOptions = {}) {
    super(options);
    this.riskEngine = new RiskEngine();
    this.ansiStripper = new AnsiStripper();
    this.screenBuffer = new ScreenBuffer();
  }

  /** Entry point: raw PTY chunk → ANSI strip → line buffer → per-line processing */
  processChunk(chunk: string): void {
    const cleaned = this.ansiStripper.strip(chunk);
    const lines = this.screenBuffer.feed(cleaned);
    for (const line of lines) {
      this.processOutput(line);
    }
  }

  processOutput(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > 20) this.buffer.shift();

    const trimmed = line.trim();

    // Detect approval prompts: "? Run command \"...\"? (Y/n)" or similar
    const approvalMatch = trimmed.match(
      /^\?\s+(?:Run command|Execute|Continue|Proceed|Apply|Write|Create|Modify)\s+(.+?)\s*\([Yy]\/[Nn]\)\s*$/,
    );
    if (approvalMatch && this.state === 'idle') {
      const command = approvalMatch[1].replace(/["""]/g, '');
      const { level, label } = this.riskEngine.evaluate(command);
      this.state = 'awaiting_approval';
      this.emitEvent({
        type: 'approval_required',
        action: 'run_command',
        command,
        cwd: this.options.cwd,
        risk: level,
        summary: label,
        contextSnippet: this.buffer.slice(-10).join('\n'),
      });
      return;
    }

    // Detect question prompts
    if (/^\?\s+(What|How|Should|Which|Where)/.test(trimmed) && this.state === 'idle') {
      this.state = 'awaiting_reply';
      this.emitEvent({
        type: 'question',
        question: trimmed.replace(/^\?\s+/, ''),
        cwd: this.options.cwd,
        contextSnippet: this.buffer.slice(-10).join('\n'),
      });
      return;
    }

    // Detect task completion
    if (/Task complete/i.test(trimmed) || /All set/.test(trimmed)) {
      this.state = 'idle';
      this.emitEvent({
        type: 'task_complete',
        summary: trimmed,
      });
      return;
    }

    // Detect errors
    if (/^(Error|Failed|ERR_)/.test(trimmed)) {
      this.emitEvent({
        type: 'error',
        message: trimmed,
        cwd: this.options.cwd,
      });
      return;
    }
  }

  processExit(code: number | null): void {
    if (code !== 0) {
      this.emitEvent({
        type: 'error',
        message: `Process exited with code ${code}`,
      });
    } else {
      this.emitEvent({
        type: 'task_complete',
        summary: 'Process exited',
      });
    }
    this.state = 'idle';
  }

  /** Called after a response is sent back to the agent (used to reset state) */
  onResponseSent(): void {
    this.state = 'idle';
  }
}
