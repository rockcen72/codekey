import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { resolveCodexBinary } from './codex-binary.js';
import type { CodexLocalSession } from './codex-local-session-resolver.js';

/**
 * Options for the resume runtime.
 */
export interface CodexResumeRuntimeOptions {
  /** Path to codex binary (resolved by codex-binary resolver) */
  binaryPath: string;
  /** Working directory for the resume session */
  cwd: string;
  /** Maximum time to wait for a single resume command (ms) */
  timeoutMs?: number;
  /** Sandbox mode for codex exec: 'read-only' | 'workspace-write' | 'none' */
  sandbox?: string;
  /** Approval policy: 'on-request' | 'never' | 'accept-all' */
  approvalPolicy?: string;
}

/**
 * Result of a single resume execution.
 */
export interface ResumeResult {
  /** Whether the resume command succeeded */
  success: boolean;
  /** Parsed events from stdout JSONL */
  events: ResumeEvent[];
  /** Raw stderr output */
  stderr: string;
  /** Exit code of the process */
  exitCode: number | null;
  /** Whether the process timed out */
  timedOut: boolean;
  /** Duration in milliseconds */
  durationMs: number;
}

/**
 * Normalized event from resume JSONL output.
 */
export interface ResumeEvent {
  type: 'message' | 'tool' | 'reasoning' | 'usage' | 'error' | 'unknown';
  role?: 'user' | 'assistant';
  content?: string;
  toolName?: string;
  toolStatus?: 'pending' | 'in_progress' | 'completed' | 'failed';
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  raw: Record<string, unknown>;
}

/**
 * Codex Resume Runtime - executes `codex exec resume` to continue sessions.
 *
 * This runtime allows CodeKey to continue a Codex session that was started
 * in the official VS Code Codex UI, by using the CLI resume capability.
 *
 * Key design:
 * - One-shot execution: each call spawns a new process, executes, and returns
 * - Serial queue: only one resume can run at a time per session
 * - Timeout protection: kills process if it hangs
 * - Event normalization: converts JSONL stdout to normalized events
 */
export class CodexResumeRuntime extends EventEmitter {
  private options: Required<CodexResumeRuntimeOptions>;
  private running = false;
  private queue: Array<{ sessionId: string; prompt: string; resolve: (result: ResumeResult) => void }> = [];

  constructor(options: CodexResumeRuntimeOptions) {
    super();
    this.options = {
      ...options,
      sandbox: options.sandbox ?? 'workspace-write',
      approvalPolicy: options.approvalPolicy ?? 'on-request',
      timeoutMs: options.timeoutMs ?? 120_000, // 2 minutes default
    };
  }

  /**
   * Execute a resume command for a given session.
   * If a resume is already running, queues the request.
   */
  async resumeOnce(sessionId: string, prompt: string): Promise<ResumeResult> {
    return new Promise((resolve) => {
      if (this.running) {
        this.queue.push({ sessionId, prompt, resolve });
        this.emit('queued', { sessionId, queueLength: this.queue.length });
      } else {
        this.executeResume(sessionId, prompt).then(resolve);
      }
    });
  }

  /**
   * Execute the actual resume command.
   */
  private async executeResume(sessionId: string, prompt: string): Promise<ResumeResult> {
    this.running = true;
    this.emit('started', { sessionId });

    const startTime = Date.now();
    const events: ResumeEvent[] = [];
    let stderr = '';
    let exitCode: number | null = null;
    let timedOut = false;

    try {
      // --sandbox, -c go before the resume subcommand — codex exec --sandbox ... resume
      const sandbox = this.options.sandbox || 'workspace-write';
      const approvalPolicy = this.options.approvalPolicy || 'on-request';
      const args = ['exec'];
      if (sandbox !== 'none') args.push('--sandbox', sandbox);
      args.push('-c', `approval_policy="${approvalPolicy}"`, 'resume', sessionId, '--json', prompt);
      const proc = spawn(this.options.binaryPath, args, {
        cwd: this.options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: this.options.timeoutMs,
      });

      // Collect stdout JSONL
      let stdoutBuffer = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuffer += chunk.toString();
        // Process complete lines
        const lines = stdoutBuffer.split('\n');
        stdoutBuffer = lines.pop() || ''; // Keep incomplete line
        for (const line of lines) {
          if (line.trim()) {
            const event = this.parseJsonlLine(line.trim());
            if (event) {
              events.push(event);
              this.emit('event', event);
            }
          }
        }
      });

      // Collect stderr
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });

      // Handle timeout
      const timeoutId = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGTERM');
        setTimeout(() => {
          if (!proc.killed) proc.kill('SIGKILL');
        }, 5000);
      }, this.options.timeoutMs);

      // Wait for process to exit
      await new Promise<void>((resolve) => {
        proc.on('exit', (code) => {
          exitCode = code;
          clearTimeout(timeoutId);
          resolve();
        });
        proc.on('error', (err) => {
          exitCode = 1;
          stderr += `\nProcess error: ${err.message}`;
          clearTimeout(timeoutId);
          resolve();
        });
      });

      // Process any remaining stdout
      if (stdoutBuffer.trim()) {
        const event = this.parseJsonlLine(stdoutBuffer.trim());
        if (event) {
          events.push(event);
          this.emit('event', event);
        }
      }

      const result: ResumeResult = {
        success: exitCode === 0 && !timedOut,
        events,
        stderr,
        exitCode,
        timedOut,
        durationMs: Date.now() - startTime,
      };

      this.emit('completed', { sessionId, result });
      return result;

    } catch (err) {
      const result: ResumeResult = {
        success: false,
        events,
        stderr: stderr + `\nExecution error: ${err}`,
        exitCode: 1,
        timedOut,
        durationMs: Date.now() - startTime,
      };

      this.emit('completed', { sessionId, result });
      return result;

    } finally {
      this.running = false;
      this.processQueue();
    }
  }

  /**
   * Process the next item in the queue.
   */
  private processQueue(): void {
    if (this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.emit('dequeued', { sessionId: next.sessionId, queueLength: this.queue.length });
    this.executeResume(next.sessionId, next.prompt).then(next.resolve);
  }

  /**
   * Parse a single JSONL line into a normalized event.
   */
  private parseJsonlLine(line: string): ResumeEvent | null {
    try {
      const obj = JSON.parse(line);
      return this.normalizeEvent(obj);
    } catch {
      return null;
    }
  }

  /**
   * Normalize a Codex JSONL event into our event format.
   *
   * `codex exec resume --json` streams events that mirror the on-disk transcript
   * shape (`response_item` / `event_msg`), so we handle that first and fall
   * back to legacy `type:"user"|"assistant"|...` shapes for safety.
   */
  private normalizeEvent(obj: Record<string, unknown>): ResumeEvent {
    const type = obj.type as string | undefined;
    const payload = (obj.payload && typeof obj.payload === 'object')
      ? (obj.payload as Record<string, unknown>)
      : null;

    // --- Real Codex shapes ---
    if (type === 'response_item' && payload) {
      const itemType = payload.type as string | undefined;
      if (itemType === 'message') {
        const role = payload.role as string | undefined;
        if (role === 'user' || role === 'assistant') {
          return {
            type: 'message',
            role,
            content: this.extractText(payload.content),
            raw: obj,
          };
        }
        return { type: 'unknown', raw: obj };
      }
      if (itemType === 'reasoning') {
        const summary = payload.summary;
        let text = '';
        if (Array.isArray(summary)) text = this.extractText(summary);
        if (!text && payload.content) text = this.extractText(payload.content);
        return { type: 'reasoning', content: text, raw: obj };
      }
      if (itemType === 'function_call') {
        const name = (payload.name as string) || 'unknown';
        const namespace = payload.namespace ? `${payload.namespace}/` : '';
        return {
          type: 'tool',
          toolName: `${namespace}${name}`,
          toolStatus: 'in_progress',
          content: typeof payload.arguments === 'string'
            ? (payload.arguments as string)
            : JSON.stringify(payload.arguments ?? {}),
          raw: obj,
        };
      }
      if (itemType === 'function_call_output') {
        return {
          type: 'tool',
          toolName: (payload.name as string) || 'unknown',
          toolStatus: 'completed',
          content: this.extractText(payload.output ?? payload.content),
          raw: obj,
        };
      }
      return { type: 'unknown', raw: obj };
    }

    if (type === 'event_msg' && payload) {
      const evt = payload.type as string | undefined;
      if (evt === 'user_message') {
        return { type: 'message', role: 'user', content: (payload.message as string) || '', raw: obj };
      }
      if (evt === 'agent_message') {
        return { type: 'message', role: 'assistant', content: (payload.message as string) || '', raw: obj };
      }
      if (evt === 'agent_reasoning' || evt === 'agent_reasoning_delta') {
        return {
          type: 'reasoning',
          content: (payload.text as string) || (payload.message as string) || '',
          raw: obj,
        };
      }
      if (evt === 'token_count' || evt === 'token_usage') {
        const info = (payload.info && typeof payload.info === 'object')
          ? (payload.info as Record<string, unknown>)
          : payload;
        return {
          type: 'usage',
          usage: {
            inputTokens: Number(info.input_tokens ?? info.inputTokens ?? 0),
            outputTokens: Number(info.output_tokens ?? info.outputTokens ?? 0),
            totalTokens: Number(info.total_tokens ?? info.totalTokens ?? 0),
          },
          raw: obj,
        };
      }
      if (evt === 'error' || evt === 'stream_error') {
        return {
          type: 'error',
          content: (payload.message as string) || (payload.error as string) || 'Codex error',
          raw: obj,
        };
      }
      return { type: 'unknown', raw: obj };
    }

    // --- Item lifecycle events (codex exec resume --json) ---
    if ((type === 'item.started' || type === 'item.completed') && obj.item) {
      const item = obj.item as Record<string, unknown>;
      const itemType = item.type as string | undefined;
      const itemStatus = (item.status as string) || (type === 'item.started' ? 'in_progress' : 'completed');

      if (itemType === 'command_execution') {
        const cmd = (item.command as string) || this.extractText(item.arguments || item.args) || '(command)';
        const toolStatus = itemStatus === 'declined' ? 'failed' as const : itemStatus === 'in_progress' ? 'in_progress' as const : 'completed' as const;
        return { type: 'tool', toolName: 'command_execution', toolStatus, content: `[${itemStatus}] ${cmd}`, raw: obj };
      }
      // --- agent_message from item.completed: real assistant reply text ---
      if (itemType === 'agent_message') {
        const text = item.text as string || item.content as string || '';
        return { type: 'message', role: 'assistant', content: text, raw: obj };
      }
      if (itemType === 'user_message') {
        const text = item.text as string || item.content as string || '';
        return { type: 'message', role: 'user', content: text, raw: obj };
      }
      if (itemType === 'turn') {
        // turn.completed — surface usage stats
        return { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 }, raw: obj };
      }
      if (itemType === 'file_change' || itemType === 'apply_patch') {
        const paths = item.path || item.paths;
        const pathStr = Array.isArray(paths) ? paths.join(', ') : (typeof paths === 'string' ? paths : '');
        const toolStatus = itemStatus === 'declined' ? 'failed' as const : itemStatus === 'in_progress' ? 'in_progress' as const : 'completed' as const;
        return { type: 'tool', toolName: itemType, toolStatus, content: `[${itemStatus}] ${pathStr || '(file)'}`, raw: obj };
      }
      return { type: 'tool', toolName: itemType || 'unknown_item', toolStatus: itemStatus === 'declined' ? 'failed' : 'completed', content: `[${itemStatus}]`, raw: obj };
    }

    if (type === 'session_meta' || type === 'turn_context') {
      return { type: 'unknown', raw: obj };
    }

    // --- Legacy synthetic shapes (kept for older fixtures / tests) ---
    if (type === 'user' && obj.message) {
      const msg = obj.message as Record<string, unknown>;
      if (msg.role === 'user') {
        return { type: 'message', role: 'user', content: this.extractText(msg.content), raw: obj };
      }
    }

    if (type === 'assistant' && obj.message) {
      const msg = obj.message as Record<string, unknown>;
      if (msg.role === 'assistant') {
        return { type: 'message', role: 'assistant', content: this.extractText(msg.content), raw: obj };
      }
    }

    if (type === 'tool_use' || obj.tool_use) {
      return {
        type: 'tool',
        toolName: (obj.name as string) || 'unknown',
        toolStatus: 'in_progress',
        content: JSON.stringify(obj.input || obj),
        raw: obj,
      };
    }

    if (type === 'tool_result' || obj.tool_result) {
      return {
        type: 'tool',
        toolName: (obj.name as string) || 'unknown',
        toolStatus: 'completed',
        content: this.extractText(obj.content || obj.output),
        raw: obj,
      };
    }

    if (type === 'thinking' || type === 'reasoning') {
      return {
        type: 'reasoning',
        content: this.extractText(obj.content || obj.text),
        raw: obj,
      };
    }

    if (type === 'usage' || obj.usage) {
      const usage = obj.usage as Record<string, unknown>;
      return {
        type: 'usage',
        usage: {
          inputTokens: (usage.input_tokens as number) || 0,
          outputTokens: (usage.output_tokens as number) || 0,
          totalTokens: (usage.total_tokens as number) || 0,
        },
        raw: obj,
      };
    }

    if (type === 'error') {
      return {
        type: 'error',
        content: (obj.message as string) || (obj.error as string) || 'Unknown error',
        raw: obj,
      };
    }

    return { type: 'unknown', raw: obj };
  }

  /**
   * Extract text content from various content formats.
   */
  private extractText(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      return content
        .map(item => {
          if (typeof item === 'string') return item;
          if (typeof item === 'object' && item !== null) {
            if (item.type === 'text' && item.text) return item.text;
            if (item.text) return item.text;
          }
          return '';
        })
        .filter(Boolean)
        .join(' ');
    }
    if (typeof content === 'object' && content !== null) {
      const obj = content as Record<string, unknown>;
      if (obj.text) return obj.text as string;
      if (obj.content) return this.extractText(obj.content);
    }
    return '';
  }

  /**
   * Check if the runtime is currently executing a resume.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the current queue length.
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * Clear the queue (does not cancel running execution).
   */
  clearQueue(): void {
    for (const item of this.queue) {
      item.resolve({
        success: false,
        events: [],
        stderr: 'Queue cleared',
        exitCode: null,
        timedOut: false,
        durationMs: 0,
      });
    }
    this.queue = [];
  }
}
