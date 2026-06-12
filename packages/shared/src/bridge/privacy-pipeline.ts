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

/** Branded payload for sendCheckedPayload — only produced by toCheckedPayload(). */
export interface PrivacyCheckedPayload {
  readonly raw: string;
  /** Brand — runtime-checkable and type-level discriminant. */
  readonly __privacyChecked: true;
  readonly checkedAt: number;
}

/**
 * Produce a PrivacyCheckedPayload from a pipeline decision.
 * This is the ONLY way to create a valid PrivacyCheckedPayload,
 * ensuring the brand type is meaningful at runtime entry points.
 */
export function toCheckedPayload(decision: PrivacyDecision): PrivacyCheckedPayload | null {
  if (decision.action !== 'send' && decision.action !== 'require_confirmation') return null;
  return {
    raw: decision.sanitizedPayload,
    __privacyChecked: true as const,
    checkedAt: Date.now(),
  };
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

/**
 * Recursively truncate all string values in a parsed JSON tree.
 * Primitives (null, boolean, number) pass through unchanged.
 */
function truncateJsonStrings(value: unknown, maxStrLen: number): unknown {
  if (typeof value === 'string') return value.slice(0, maxStrLen);
  if (Array.isArray(value)) return value.map(v => truncateJsonStrings(v, maxStrLen));
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = truncateJsonStrings(v, maxStrLen);
    }
    return result;
  }
  return value;
}

/**
 * Drop trailing entries from objects/arrays until the stringified result
 * fits within `maxLen`.  Last-resort fallback when even 1-char strings
 * exceed the limit (extremely many fields).
 *
 * When recursing into nested values, the budget is reduced to account
 * for the parent's structural overhead, so the child doesn't consume
 * more than its fair share and later get dropped by the parent.
 */
function squeezeToMaxLen(value: unknown, maxLen: number): unknown {
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (const item of value) {
      result.push(squeezeToMaxLen(item, maxLen));
      if (JSON.stringify(result).length > maxLen) {
        result.pop();
        break;
      }
    }
    return result;
  }
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const currentSize = JSON.stringify(result).length;
      const overhead = k.length + 6; // `,"key":` or `"key":` for first entry
      const budget = Math.max(2, maxLen - currentSize - overhead);
      result[k] = typeof v === 'object' && v !== null ? squeezeToMaxLen(v, budget) : v;
      if (JSON.stringify(result).length > maxLen) {
        delete result[k];
        break;
      }
    }
    return result;
  }
  return value;
}

/**
 * Truncate a string to `maxLen` while guaranteeing the output is valid JSON
 * and never exceeds `maxLen`.
 *
 * Strategy (in order of preference):
 *   1. Raw slice — if the cut happens to land on a JSON boundary, return it.
 *   2. Deep string truncation — parse the full object, iteratively halve the
 *      per-string limit until the re-stringified result fits.
 *   3. Squeeze — drop trailing entries when structure (not string length)
 *      pushes the total over maxLen.  Always produces valid JSON ≤ maxLen.
 */
export function truncateSafe(payload: string, maxLen: number): string {
  if (payload.length <= maxLen) return payload;

  const sliced = payload.slice(0, maxLen);
  try {
    JSON.parse(sliced);
    return sliced;
  } catch {
    try {
      const parsed = JSON.parse(payload);
      // 2. Deep string truncation
      let strLimit = 2000;
      while (true) {
        const reStrung = JSON.stringify(truncateJsonStrings(parsed, strLimit));
        if (reStrung.length <= maxLen) return reStrung;
        if (strLimit <= 1) break;
        strLimit = Math.ceil(strLimit / 2);
      }
      // 3. Squeeze — drop entries if structure alone exceeds maxLen
      const packedAt1 = JSON.stringify(truncateJsonStrings(parsed, 1));
      if (packedAt1.length <= maxLen) return packedAt1;
      return JSON.stringify(squeezeToMaxLen(truncateJsonStrings(parsed, 1), maxLen));
    } catch {
      return sliced;
    }
  }
}

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
 * Handles Unix, Windows, and relative paths.
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

  // Heuristic: extract file-like tokens from command string.
  // Catches: "cat .env", "rm -rf /repo/.env", "type F:\file.env"
  if (raw) {
    // Unix absolute paths: /etc/passwd, /repo/.env
    const unix = raw.match(/(?:\/[\w.-]+)+/g);
    if (unix) for (const m of unix) set.add(m);

    // Windows absolute paths: C:\foo, F:\repo\.env
    const win = raw.match(/[A-Za-z]:\\[^\s"'`|<>]+/g);
    if (win) for (const m of win) set.add(m);

    // Relative paths starting with ./ or ..
    const relative = raw.match(/(?:\.{1,2}\/)[^\s"'`|<>]+/g);
    if (relative) for (const m of relative) set.add(m);

    // Bare file-like tokens ("cat .env", "rm node_modules/foo")
    const bare = raw.match(/(?:^|\s+)([\w.-]+(?:\/[\w.-]+)*)/g);
    if (bare) for (const m of bare) set.add(m.trim());
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
  const trimmedPayload = truncated ? truncateSafe(sanitizedPayload, maxLen) : sanitizedPayload;

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
