import { EventEmitter } from 'node:events';
import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { resolveCodexBinary, type CodexBinarySearchOptions } from './codex-binary.js';
import { toCodexDecision, classifyServerRequest, type CodexServerRequestMethod, type ServerRequestKind } from './codex-decision.js';
import type { Decision } from '../types.js';

// ── Types ───────────────────────────────────────────────────

export type RequestId = string | number;

export interface ServerRequestMessage {
  id: RequestId;
  method: CodexServerRequestMethod;
  params: Record<string, unknown>;
}

export interface JsonRpcResponse {
  id: RequestId;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface JsonRpcRequest {
  id: RequestId;
  method: string;
  params?: unknown;
}

interface PendingEntry {
  request: ServerRequestMessage;
  kind: ServerRequestKind;
  status: 'pending' | 'responded' | 'resolved' | 'expired';
  timer: ReturnType<typeof setTimeout>;
  method: string;
}

export interface CodexAppServerClientOptions {
  binarySearch: CodexBinarySearchOptions;
  /** CWD for the Codex session (thread cwd). */
  cwd: string;
  /** Called for approval-type ServerRequests (commandExecution, fileChange, permissions). */
  onApproval?: (req: ServerRequestMessage) => void;
  /** Called for input-type ServerRequests (tool/requestUserInput). */
  onInput?: (req: ServerRequestMessage) => void;
  /** Called when an approval/input request times out or the process dies. */
  onExpired?: (requestId: RequestId, reason: string) => void;
}

const RESTART_MAX = 3;
const RESTART_BASE_MS = 2_000;
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const RESOLVED_TIMEOUT_MS = 30_000;

// ── Client ──────────────────────────────────────────────────

export class CodexAppServerClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private rl: ReturnType<typeof createInterface> | null = null;
  private destroyed = false;
  /** Auto-restart counter. Incremented in onExit, reset on explicit user start() via resetRestartCount(). */
  private restartCount = 0;
  /** Saved restart timer handle so stop() can cancel it. */
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private threadId: string | null = null;
  private seq = 0;

  /** Pending ServerRequests keyed by JSON-RPC request id. */
  private pending = new Map<RequestId, PendingEntry>();
  /** Outgoing JSON-RPC requests keyed by our request id. */
  private outgoing = new Map<RequestId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  private opts: CodexAppServerClientOptions;
  private binaryPath: string | null = null;

  constructor(opts: CodexAppServerClientOptions) {
    super();
    this.opts = opts;
  }

  // ── Public API ─────────────────────────────────────────

  /** Start the app-server process and initialize. Resolves once initialized.
   *  Internal auto-restart calls use `{ internal: true }` to avoid resetting the crash counter. */
  async start(opts?: { internal?: boolean }): Promise<void> {
    if (!opts?.internal) this.restartCount = 0; // reset counter only on explicit external start
    this.binaryPath = resolveCodexBinary(this.opts.binarySearch);
    if (!this.binaryPath) throw new Error('Codex binary not found');

    const proc = spawn(this.binaryPath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: this.opts.cwd,
      env: { ...process.env },
    });
    this.proc = proc;

    this.rl = createInterface({ input: proc.stdout!, terminal: false });
    this.rl.on('line', (line: string) => {
      try {
        const msg = JSON.parse(line.trim());
        this.onMessage(msg);
      } catch {
        // skip malformed lines
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text && /error|Error|ERROR/.test(text)) {
        this.emit('stderr', text);
      }
    });

    proc.on('exit', (code) => this.onExit(code));
    proc.on('error', (err) => {
      this.emit('error', err);
      this.onExit(null);
    });

    // Wait for initialize response
    await this.request('initialize', {
      clientInfo: { name: 'codekey', version: '0.1.0' },
    });
  }

  /** Graceful stop. Kills the process and cancels any pending restart. */
  async stop(): Promise<void> {
    this.destroyed = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.expireAllPending('Client shutting down');
    if (this.proc) {
      this.proc.kill();
      this.proc = null;
    }
    this.rl?.close();
    this.rl = null;
  }

  /** Start a new Codex thread. Returns thread id. */
  async startThread(sandbox: 'workspace-write' | 'read-only' = 'workspace-write'): Promise<string> {
    const resp = await this.request('thread/start', {
      cwd: this.opts.cwd,
      sandbox,
      approvalPolicy: 'untrusted',
    }) as { thread?: { id: string } };
    if (!resp?.thread?.id) throw new Error('thread/start: no thread.id in response');
    this.threadId = resp.thread.id;
    return this.threadId;
  }

  /** Send a prompt to the Codex agent. Returns the thread id. */
  async startTurn(prompt: string): Promise<string> {
    if (!this.threadId) throw new Error('No thread started yet — call startThread first');
    await this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text: prompt }],
    });
    return this.threadId;
  }

  /** Respond to an approval ServerRequest. Only valid for approval-kind requests. */
  respondApproval(requestId: RequestId, decision: Decision): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.status !== 'pending') return;
    if (entry.kind !== 'approval') {
      this.emit('warn', `respondApproval called for non-approval request ${requestId} (kind=${entry.kind}) — ignored`);
      return;
    }

    // Validate mapping before mutating state — toCodexDecision throws on 'reply'
    const codexDecision = toCodexDecision(decision);

    entry.status = 'responded';
    clearTimeout(entry.timer);
    this.send({ id: requestId, result: { decision: codexDecision } });

    // Set a shorter timeout to wait for serverRequest/resolved
    entry.timer = setTimeout(() => {
      if (entry.status === 'responded') {
        entry.status = 'expired';
        this.emit('warn', `Approval ${requestId} sent but no serverRequest/resolved within ${RESOLVED_TIMEOUT_MS}ms`);
      }
    }, RESOLVED_TIMEOUT_MS);
  }

  /** Respond to a requestUserInput ServerRequest with answers keyed by question id.
   *  Format per ToolRequestUserInputResponse schema:
   *    { answers: { [questionId]: { answers: string[] } } }
   *  The caller provides flat { qId: [userInput] }, this wraps each value in { answers: [...] }. */
  respondInput(requestId: RequestId, flatAnswers: Record<string, string[]>): void {
    const entry = this.pending.get(requestId);
    if (!entry || entry.status !== 'pending') return;
    if (entry.kind !== 'input') {
      this.emit('warn', `respondInput called for non-input request ${requestId} (kind=${entry.kind}) — ignored`);
      return;
    }

    // Wrap each entry per schema: { qId: ["x"] } → { qId: { answers: ["x"] } }
    const wrapped: Record<string, { answers: string[] }> = {};
    for (const [qId, ans] of Object.entries(flatAnswers)) {
      wrapped[qId] = { answers: ans };
    }

    entry.status = 'responded';
    clearTimeout(entry.timer);
    this.send({ id: requestId, result: { answers: wrapped } });

    // Input responses may not trigger serverRequest/resolved; clean up after 5s
    entry.timer = setTimeout(() => {
      if (entry.status === 'responded') {
        entry.status = 'resolved';
        this.pending.delete(requestId);
      }
    }, 5_000);
  }

  /** Current thread id, or null if no thread started. */
  get currentThreadId(): string | null {
    return this.threadId;
  }

  /** Number of pending approvals (not yet responded). */
  get pendingApprovalCount(): number {
    let count = 0;
    for (const e of this.pending.values()) {
      if (e.kind === 'approval' && e.status === 'pending') count++;
    }
    return count;
  }

  /** Whether the underlying process is believed to be alive. */
  get isRunning(): boolean {
    return this.proc !== null && this.proc.exitCode === null;
  }

  // ── Internal ───────────────────────────────────────────

  private nextId(): string {
    return `ck-${++this.seq}-${Date.now()}`;
  }

  private send(msg: unknown): void {
    if (!this.proc?.stdin) return;
    this.proc.stdin.write(JSON.stringify(msg) + '\n');
  }

  /** Send a JSON-RPC request and wait for response. */
  private request(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.nextId();
      this.send({ id, method, params });
      const timer = setTimeout(() => {
        this.outgoing.delete(id);
        reject(new Error(`Request ${method} timed out`));
      }, 30_000);
      this.outgoing.set(id, { resolve, reject, timer });
    });
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = msg.id != null ? (msg.id as RequestId) : null;

    // JSON-RPC response to our outgoing request (has id, no method, no error field for success)
    if (id != null && !msg.method) {
      const entry = this.outgoing.get(id);
      if (entry) {
        clearTimeout(entry.timer);
        this.outgoing.delete(id);
        if (msg.error) {
          entry.reject(new Error(`JSON-RPC error: ${JSON.stringify(msg.error)}`));
        } else {
          entry.resolve(msg.result);
        }
      }
      return;
    }

    // ServerRequest (has method + id) — needs response
    if (msg.method && id != null) {
      const method = msg.method as string;
      const params = (msg.params || {}) as Record<string, unknown>;
      const requestId = id;

      // Categorize the method — must match exactly
      const kind = classifyServerRequest(method);
      if (kind === null) {
        this.emit('warn', `Unknown ServerRequest method: ${method} — ignoring`);
        return;
      }

      // Permissions request (MVP: warn and decline — response format differs from simple approval)
      if (kind === 'permissions') {
        this.emit('warn', `Permissions request received — MVP does not support permissions approval, declining`);
        this.send({ id: requestId, result: { permissions: {}, scope: 'turn' } });
        return;
      }

      const entry: PendingEntry = {
        request: { id: requestId, method: method as CodexServerRequestMethod, params },
        kind,
        status: 'pending',
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          if (kind === 'approval') {
            this.send({ id: requestId, result: { decision: 'decline' } });
          } else {
            // input timeout: per ToolRequestUserInputResponse schema
            this.send({ id: requestId, result: { answers: {} } });
          }
          this.opts.onExpired?.(requestId, `Timed out after ${APPROVAL_TIMEOUT_MS}ms`);
          this.emit('expired', { requestId, reason: 'timeout' });
        }, APPROVAL_TIMEOUT_MS),
        method,
      };
      this.pending.set(requestId, entry);
      this.emit('server_request', entry.request);
      if (kind === 'approval') {
        this.opts.onApproval?.(entry.request);
      } else {
        this.opts.onInput?.(entry.request);
      }
      return;
    }

    // Notification (method without id)
    if (msg.method && msg.id === undefined) {
      const method = msg.method as string;
      this.handleNotification(method, msg);
    }
  }

  private handleNotification(method: string, _msg: Record<string, unknown>): void {
    // serverRequest/resolved — confirms a specific decision was accepted
    if (method === 'serverRequest/resolved') {
      const resolvedId = (_msg.params as Record<string, unknown> | undefined)?.requestId;
      if (resolvedId != null) {
        const entry = this.pending.get(resolvedId as RequestId);
        if (entry && entry.status === 'responded') {
          entry.status = 'resolved';
          clearTimeout(entry.timer);
          this.pending.delete(resolvedId as RequestId);
        }
      }
      return;
    }

    // Notifications we forward
    const forwardable = [
      'turn/started',
      'turn/completed',
      'thread/status/changed',
      'item/started',
      'item/completed',
      'thread/tokenUsage/updated',
    ];
    if (forwardable.includes(method)) {
      this.emit('notification', method, _msg);
    }
    // All other notifications (agentMessage/delta, mcpServer/*, etc.) are filtered
  }

  private expireAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.status = 'expired';
      this.opts.onExpired?.(id, reason);
    }
    this.pending.clear();
  }

  private onExit(code: number | null): void {
    this.proc = null;
    this.rl?.close();
    this.rl = null;

    // All pending ServerRequests from the dead process are unrecoverable
    this.expireAllPending(`Codex app-server exited (code=${code})`);

    // Reject all outgoing requests immediately (don't wait for 30s timeout)
    for (const [id, entry] of this.outgoing) {
      clearTimeout(entry.timer);
      entry.reject(new Error(`Codex app-server exited (code=${code})`));
    }
    this.outgoing.clear();

    if (this.destroyed) return;
    if (this.restartCount >= RESTART_MAX) {
      this.emit('error', new Error(`Codex app-server crashed ${RESTART_MAX} times, giving up`));
      return;
    }

    this.restartCount++;
    const delay = Math.min(RESTART_BASE_MS * Math.pow(2, this.restartCount - 1), 10_000);
    this.emit('reconnecting', { attempt: this.restartCount, delay });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.destroyed) return;
      this.start({ internal: true }).catch((err) => this.emit('error', err));
    }, delay);
  }
}
