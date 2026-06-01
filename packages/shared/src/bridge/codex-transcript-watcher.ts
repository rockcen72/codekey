import { EventEmitter } from 'node:events';
import { existsSync, statSync, readFileSync, watch, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Options for the transcript watcher.
 */
export interface CodexTranscriptWatcherOptions {
  /** Path to the transcript file to watch */
  transcriptPath: string;
  /** Poll interval in ms (fallback when FS watcher is unreliable) */
  pollIntervalMs?: number;
}

/**
 * Normalized event from transcript JSONL.
 */
export interface TranscriptEvent {
  type: 'message' | 'tool' | 'reasoning' | 'usage' | 'error' | 'unknown';
  role?: 'user' | 'assistant';
  content?: string;
  toolName?: string;
  toolStatus?: 'pending' | 'in_progress' | 'completed' | 'failed';
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number };
  timestamp?: string;
  raw: Record<string, unknown>;
}

/**
 * Watches a Codex transcript JSONL file for new entries.
 *
 * This watcher monitors a Codex session transcript file and emits
 * normalized events as new lines are appended. It handles:
 * - File size tracking to only process new content
 * - JSONL parsing with error recovery
 * - Event normalization to match the resume runtime format
 * - FS watcher with polling fallback
 */
export class CodexTranscriptWatcher extends EventEmitter {
  private transcriptPath: string;
  private pollIntervalMs: number;
  private watcher: FSWatcher | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastSize = 0;
  private lastProcessedLine = 0;
  private running = false;

  constructor(options: CodexTranscriptWatcherOptions) {
    super();
    this.transcriptPath = options.transcriptPath;
    this.pollIntervalMs = options.pollIntervalMs ?? 2000;
  }

  /**
   * Start watching the transcript file.
   */
  start(): void {
    if (this.running) return;
    if (!existsSync(this.transcriptPath)) {
      this.emit('error', new Error(`Transcript file not found: ${this.transcriptPath}`));
      return;
    }

    this.running = true;

    // Initialize size tracking and process existing content
    try {
      const stat = statSync(this.transcriptPath);
      this.lastSize = stat.size;

      // Process existing content on first start
      if (this.lastSize > 0) {
        const content = readFileSync(this.transcriptPath, 'utf8');
        if (content.trim()) {
          this.processNewContent(content);
        }
      }
    } catch {
      this.lastSize = 0;
    }

    // Try FS watcher first (more responsive)
    try {
      this.watcher = watch(this.transcriptPath, { persistent: false }, (eventType) => {
        if (eventType === 'change') {
          this.checkForNewContent();
        }
      });
      this.watcher.on('error', () => {
        // FS watcher failed, fall back to polling
        this.startPolling();
      });
    } catch {
      // FS watcher not available, use polling
      this.startPolling();
    }

    this.emit('started', { path: this.transcriptPath });
  }

  /**
   * Stop watching the transcript file.
   */
  stop(): void {
    this.running = false;

    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    this.emit('stopped', { path: this.transcriptPath });
  }

  /**
   * Start polling as fallback when FS watcher is unreliable.
   */
  private startPolling(): void {
    if (this.pollTimer) return;
    this.pollTimer = setInterval(() => {
      this.checkForNewContent();
    }, this.pollIntervalMs);
  }

  /**
   * Check for new content in the transcript file.
   */
  private checkForNewContent(): void {
    if (!this.running) return;

    try {
      const stat = statSync(this.transcriptPath);
      const currentSize = stat.size;

      // On first check, process entire file if it has content
      if (this.lastSize === 0 && currentSize > 0) {
        const content = readFileSync(this.transcriptPath, 'utf8');
        if (content.trim()) {
          this.processNewContent(content);
        }
        this.lastSize = currentSize;
        return;
      }

      if (currentSize <= this.lastSize) return;

      // Read only the new content
      const newContent = this.readNewContent(this.lastSize, currentSize);
      this.lastSize = currentSize;

      if (newContent) {
        this.processNewContent(newContent);
      }
    } catch (err) {
      this.emit('error', err);
    }
  }

  /**
   * Read new content from the file between two byte offsets.
   */
  private readNewContent(startByte: number, endByte: number): string {
    try {
      const content = readFileSync(this.transcriptPath, 'utf8');
      // Simple approach: read from start and process only new lines
      // For large files, this could be optimized with fs.read with offset
      const lines = content.split('\n');
      const newLines = lines.slice(this.lastProcessedLine);
      this.lastProcessedLine = lines.length;
      return newLines.join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Process new JSONL content and emit events.
   */
  private processNewContent(content: string): void {
    const lines = content.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        const event = this.normalizeEvent(obj);
        if (event) {
          this.emit('event', event);
        }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  /**
   * Normalize a transcript JSONL event into our event format.
   */
  private normalizeEvent(obj: Record<string, unknown>): TranscriptEvent | null {
    const type = obj.type as string;
    const timestamp = obj.timestamp as string;

    // User message
    if (type === 'user' && obj.message) {
      const msg = obj.message as Record<string, unknown>;
      if (msg.role === 'user') {
        return {
          type: 'message',
          role: 'user',
          content: this.extractText(msg.content),
          timestamp,
          raw: obj,
        };
      }
    }

    // Assistant message
    if (type === 'assistant' && obj.message) {
      const msg = obj.message as Record<string, unknown>;
      if (msg.role === 'assistant') {
        return {
          type: 'message',
          role: 'assistant',
          content: this.extractText(msg.content),
          timestamp,
          raw: obj,
        };
      }
    }

    // Tool use
    if (type === 'tool_use' || obj.tool_use) {
      return {
        type: 'tool',
        toolName: (obj.name as string) || 'unknown',
        toolStatus: 'in_progress',
        content: JSON.stringify(obj.input || obj),
        timestamp,
        raw: obj,
      };
    }

    // Tool result
    if (type === 'tool_result' || obj.tool_result) {
      return {
        type: 'tool',
        toolName: (obj.name as string) || 'unknown',
        toolStatus: 'completed',
        content: this.extractText(obj.content || obj.output),
        timestamp,
        raw: obj,
      };
    }

    // Reasoning/thinking
    if (type === 'thinking' || type === 'reasoning') {
      return {
        type: 'reasoning',
        content: this.extractText(obj.content || obj.text),
        timestamp,
        raw: obj,
      };
    }

    // Usage statistics
    if (type === 'usage' || obj.usage) {
      const usage = obj.usage as Record<string, unknown>;
      return {
        type: 'usage',
        usage: {
          inputTokens: (usage.input_tokens as number) || 0,
          outputTokens: (usage.output_tokens as number) || 0,
          totalTokens: (usage.total_tokens as number) || 0,
        },
        timestamp,
        raw: obj,
      };
    }

    // Error
    if (type === 'error') {
      return {
        type: 'error',
        content: (obj.message as string) || (obj.error as string) || 'Unknown error',
        timestamp,
        raw: obj,
      };
    }

    // Session metadata - emit but don't normalize
    if (type === 'session_meta') {
      return {
        type: 'unknown',
        timestamp,
        raw: obj,
      };
    }

    // Unknown event type
    return {
      type: 'unknown',
      timestamp,
      raw: obj,
    };
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
   * Check if the watcher is currently running.
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get the path being watched.
   */
  getPath(): string {
    return this.transcriptPath;
  }
}
