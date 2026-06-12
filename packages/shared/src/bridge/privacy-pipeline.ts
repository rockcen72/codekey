/**
 * Privacy pipeline — the single outbound gate for all data leaving
 * the local machine and going to the relay server.
 *
 * Every event type (approval, transcript, command, history) must
 * pass through `runPrivacyPipeline` before being sent via
 * `RelayClient.sendCheckedPayload`.
 *
 * The pipeline performs, in order:
 *   1. Path extraction from structured + unstructured payload
 *   2. .codekeyignore / blocklist filtering
 *   3. Secret scanning and redaction
 *   4. Field trimming (source-dependent)
 *   5. Audit logging (via injected callback)
 *   6. Decision: send / block / require_confirmation
 */

import { scan, replace, type Finding } from './secret-scanner.js';
import { CodeKeyIgnore } from './codekeyignore.js';
import { DEFAULT_BLOCKED_PATTERNS, matchesAny } from './blocklist.js';

export type SourceType = 'approval' | 'transcript' | 'history' | 'command';

export interface PrivacyContext {
  /** Which component generated this payload */
  source: SourceType;
  /** Human-readable agent name (e.g. "Claude Code", "Codex") */
  agent?: string;
  /** Opaque session identifier for correlation */
  sessionId?: string;

  /** The raw text payload to inspect and potentially redact */
  rawPayload: string;

  /** Structured tool call data (may contain file_path, path, etc.) */
  structuredPayload?: Record<string, unknown>;

  /** Additional file paths associated with this event (if known) */
  extraPaths?: string[];
}

export interface PrivacyDecision {
  action: 'send' | 'block' | 'require_confirmation' | 'skip';
  /** The redacted/trimmed payload ready for transmission */
  sanitizedPayload: string;
  /** File paths that were blocked by .codekeyignore or blocklist */
  blockedPaths: string[];
  /** Secrets that were found and redacted */
  sanitizedFindings: Finding[];
  /** Whether the payload was truncated due to size limits */
  truncated: boolean;
  /** Which rules applied */
  blockedByCodekeyIgnore: boolean;
  blockedByDefault: boolean;
}

export interface AuditEntry {
  timestamp: string;
  source: SourceType;
  agent?: string;
  sessionId?: string;
  action: 'forwarded' | 'rejected' | 'blocked' | 'sanitized';
  sanitized: boolean;
  blocked: boolean;
  payloadPreview: string;
  findingCount: number;
  payloadLength: number;
}

/** Callback type for audit logging. Injected by the host (VS Code). */
export type AuditSink = (entry: AuditEntry) => void;

/** Size limits per source type (in characters) */
const MAX_LENGTH: Record<SourceType, number> = {
  approval: 50_000,
  transcript: 20_000,
  history: 10_000,
  command: 5_000,
};

const EMPTY_DECISION: PrivacyDecision = {
  action: 'skip',
  sanitizedPayload: '',
  blockedPaths: [],
  sanitizedFindings: [],
  truncated: false,
  blockedByCodekeyIgnore: false,
  blockedByDefault: false,
};

/**
 * Extract file paths from a structured payload and/or raw string.
 * Priority: structuredPayload > extraPaths > heuristic from raw.
 */
function extractPaths(
  structured?: Record<string, unknown>,
  extraPaths?: string[],
  raw?: string,
): string[] {
  const set = new Set<string>();

  // Extra paths supplied by the caller
  if (extraPaths) for (const p of extraPaths) if (p) set.add(p);

  // Structured extraction from tool_input or top-level fields
  if (structured) {
    for (const key of ['file_path', 'path', 'directory', 'target', 'cwd']) {
      const v = structured[key];
      if (typeof v === 'string' && v.trim()) set.add(v.trim());
    }
    const input = structured['tool_input'];
    if (typeof input === 'object' && input) {
      for (const key of ['file_path', 'path', 'directory', 'command']) {
        const v = (input as Record<string, unknown>)[key];
        if (typeof v === 'string' && v.trim()) set.add(v.trim());
      }
    }
  }

  // Heuristic: extract plausible paths from command string
  if (raw) {
    const matches = raw.match(/(?:\/[\w.-]+)+/g);
    if (matches) for (const m of matches) set.add(m);
  }

  return [...set];
}

/**
 * Run the full privacy pipeline on a payload.
 *
 * @param ctx    The event context to inspect
 * @param cwd    Optional workspace directory (for .codekeyignore loading)
 * @param sink   Optional audit logging callback
 * @returns      A decision with the redacted payload and metadata
 */
export function runPrivacyPipeline(
  ctx: PrivacyContext,
  cwd?: string,
  sink?: AuditSink,
): PrivacyDecision {
  if (!ctx.rawPayload) return EMPTY_DECISION;

  const codekeyIgnore = new CodeKeyIgnore(cwd);
  const paths = extractPaths(ctx.structuredPayload, ctx.extraPaths, ctx.rawPayload);

  // ── 1. Blocklist / .codekeyignore filtering ──
  const blockedByCodekeyIgnore = paths.filter((p) => codekeyIgnore.isBlocked(p));
  const blockedByDefault = paths.filter((p) => matchesAny(p, DEFAULT_BLOCKED_PATTERNS));
  const allBlocked = [...blockedByCodekeyIgnore, ...blockedByDefault];
  const dedupedBlocked = [...new Set(allBlocked)];

  // ── 2. Secret scanning ──
  const findings = scan(ctx.rawPayload);
  const sanitizedPayload = replace(ctx.rawPayload, findings);

  // ── 3. Field trimming ──
  const maxLen = MAX_LENGTH[ctx.source] ?? MAX_LENGTH.command;
  const truncated = sanitizedPayload.length > maxLen;
  const trimmedPayload = truncated ? sanitizedPayload.slice(0, maxLen) : sanitizedPayload;

  // ── 4. Decision ──
  let action: PrivacyDecision['action'] = 'send';
  if (dedupedBlocked.length > 0 && ctx.source === 'approval') {
    action = 'require_confirmation';
  }
  if (ctx.source === 'transcript' && dedupedBlocked.length > 0) {
    action = 'block';
  }

  const decision: PrivacyDecision = {
    action,
    sanitizedPayload: trimmedPayload,
    blockedPaths: dedupedBlocked,
    sanitizedFindings: findings,
    truncated,
    blockedByCodekeyIgnore: blockedByCodekeyIgnore.length > 0,
    blockedByDefault: blockedByDefault.length > 0,
  };

  // ── 5. Audit ──
  if (sink) {
    sink({
      timestamp: new Date().toISOString(),
      source: ctx.source,
      agent: ctx.agent,
      sessionId: ctx.sessionId,
      action: findings.length > 0
        ? 'sanitized'
        : action === 'block'
          ? 'blocked'
          : 'forwarded',
      sanitized: findings.length > 0,
      blocked: action === 'block',
      payloadPreview: trimmedPayload.slice(0, 200),
      findingCount: findings.length,
      payloadLength: ctx.rawPayload.length,
    });
  }

  return decision;
}
