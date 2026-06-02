import { createReadStream, existsSync, readdirSync, statSync, openSync, readSync, closeSync, fstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

/**
 * Resolve the Codex config directory.
 * Checks CODEX_HOME env var first, falls back to ~/.codex.
 */
export function codexConfigDir(): string {
  return process.env.CODEX_HOME?.trim() || path.join(homedir(), '.codex');
}

/**
 * Represents a discovered Codex local session from transcript/session_index.
 */
export interface CodexLocalSession {
  /** Codex session id (UUID) */
  sessionId: string;
  /** Working directory from session_meta */
  cwd: string;
  /** Session title (from thread_name or first user message) */
  title: string;
  /** Absolute path to the transcript JSONL file */
  transcriptPath: string;
  /** Source of the session (e.g. 'vscode', 'cli') */
  source: string;
  /** ISO timestamp of last activity (from transcript tail or session_index updatedAt) */
  updatedAt: string;
  /** ISO timestamp of session creation */
  createdAt: string;
}

interface SessionIndexEntry {
  id: string;
  thread_name?: string;
  updated_at?: string;
}

interface TranscriptMetaPayload {
  id?: string;
  cwd?: string;
  source?: string;
  cli_version?: string;
}

/**
 * Parse ~/.codex/session_index.jsonl for quick session listing.
 * Returns entries in file order (newest first, as Codex writes them).
 */
export function parseSessionIndex(indexPath: string): SessionIndexEntry[] {
  if (!existsSync(indexPath)) return [];
  const entries: SessionIndexEntry[] = [];
  try {
    const text = readFileSync(indexPath, 'utf8');
    const lines = text.split('\n');
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line) as SessionIndexEntry;
        if (obj.id) entries.push(obj);
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file not readable */ }
  return entries;
}

/**
 * Read the first session_meta from a transcript JSONL file.
 * Returns null if no valid session_meta found.
 */
export function readSessionMeta(transcriptPath: string): TranscriptMetaPayload | null {
  if (!existsSync(transcriptPath)) return null;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = readSync(fd, buf, 0, 65536, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'session_meta' && obj.payload) {
            return obj.payload as TranscriptMetaPayload;
          }
        } catch { /* skip malformed */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * Read the last ~64KB of a JSONL file and return the latest timestamp found.
 */
function lastTranscriptTimestamp(filePath: string): string {
  try {
    const fd = openSync(filePath, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size === 0) return '';
      const readSize = Math.min(size, 65536);
      const buf = Buffer.alloc(readSize);
      readSync(fd, buf, 0, readSize, size - readSize);
      const lines = buf.toString('utf8').split('\n').filter(l => l.trim());
      for (let i = lines.length - 1; i >= 0; i--) {
        try {
          const line = JSON.parse(lines[i]);
          if (line.timestamp) {
            const parsed = new Date(line.timestamp);
            if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
          }
        } catch { /* skip malformed */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore */ }
  return '';
}

/**
 * Extract the first user message as a title fallback.
 */
/** Extract meaningful first user prompt from a Codex transcript.
 *  Skips auto-injected environment context. */
function extractFirstUserMessage(transcriptPath: string): string {
  if (!existsSync(transcriptPath)) return '';
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(65536);
      const bytesRead = readSync(fd, buf, 0, 65536, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          const msg = extractUserMsgText(obj);
          const visible = msg ? cleanCodexDisplayText(msg) : '';
          if (visible) return visible.slice(0, 100);
        } catch { /* skip */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore */ }
  return '';
}

/** Extract user message text from any known transcript envelope format. */
function extractUserMsgText(obj: Record<string, unknown>): string | null {
  const payload = (obj.payload && typeof obj.payload === 'object') ? obj.payload as Record<string, unknown> : null;
  const message = (obj.message && typeof obj.message === 'object') ? obj.message as Record<string, unknown> : null;
  // Real Codex: response_item with user message
  if (obj.type === 'response_item' && payload?.type === 'message' && payload?.role === 'user') {
    const content = payload.content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && (part.type === 'input_text' || part.type === 'text') && part.text) {
          return String(part.text);
        }
      }
    }
    if (typeof content === 'string') return content;
  }
  // Real Codex: event_msg with user_message
  if (obj.type === 'event_msg' && payload?.type === 'user_message') {
    const msg = payload.message;
    if (typeof msg === 'string' && msg.trim()) return msg.trim();
  }
  // Legacy: type: 'user'
  if (obj.type === 'user' && !obj.isMeta && message?.role === 'user') {
    const content = message.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === 'object' && part.type === 'text' && part.text) {
          return part.text;
        }
      }
    }
  }
  return null;
}

/** Skip auto-injected environment context blocks. */
function isAutoContext(text: string): boolean {
  return cleanCodexDisplayText(text).length === 0;
}

/**
 * Recursively scan a directory for .jsonl files, up to a max depth.
 * Codex writes real transcripts to ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
 * (three levels deep), so a depth of 6 is more than enough while still bounded.
 */
function collectJsonl(dir: string, depth: number, out: { path: string; mtime: number }[]): void {
  if (depth < 0) return;
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true }) as import('node:fs').Dirent[];
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectJsonl(full, depth - 1, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    try {
      const stat = statSync(full);
      out.push({ path: full, mtime: stat.mtimeMs });
    } catch { /* skip unreadable */ }
  }
}

/**
 * Scan ~/.codex/sessions/ recursively for all .jsonl transcript files.
 * Returns absolute paths sorted by modification time (newest first).
 *
 * Real Codex layout is ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl,
 * but we recurse so a flatter or deeper layout also works.
 */
function scanTranscriptFiles(): string[] {
  const baseDir = path.join(codexConfigDir(), 'sessions');
  if (!existsSync(baseDir)) return [];

  const files: { path: string; mtime: number }[] = [];
  collectJsonl(baseDir, 6, files);

  files.sort((a, b) => b.mtime - a.mtime);
  return files.map(f => f.path);
}

/**
 * Discover all recent Codex local sessions.
 *
 * Strategy:
 * 1. Recursively scan ~/.codex/sessions/ for .jsonl transcript files
 *    (real layout is YYYY/MM/DD/rollout-*.jsonl, but we tolerate flatter trees)
 * 2. For each transcript, read session_meta from the first 64KB
 * 3. Filter out transcripts without a valid session id
 * 4. Build CodexLocalSession list, sorted by updatedAt (newest first)
 *
 * session_index.jsonl may lag behind, so we scan transcripts directly.
 * session_index is used only as a supplementary title source.
 *
 * @param limit Maximum number of sessions to return
 * @param cwd Optional workspace path to prioritize matching sessions
 */
export function discoverLocalSessions(limit = 20, cwd?: string): CodexLocalSession[] {
  const transcriptPaths = scanTranscriptFiles();
  const indexEntries = parseSessionIndex(path.join(codexConfigDir(), 'session_index.jsonl'));

  // Build a quick lookup from session_index for thread_name
  const indexByName = new Map<string, SessionIndexEntry>();
  for (const entry of indexEntries) {
    indexByName.set(entry.id, entry);
  }

  const sessions: CodexLocalSession[] = [];

  for (const transcriptPath of transcriptPaths) {
    const meta = readSessionMeta(transcriptPath);
    if (!meta?.id) continue; // skip transcripts without a session id

    const sessionId = meta.id;
    const indexEntry = indexByName.get(sessionId);

    const session: CodexLocalSession = {
      sessionId,
      cwd: meta.cwd || '',
      title: indexEntry?.thread_name || extractFirstUserMessage(transcriptPath) || sessionId.slice(0, 8),
      transcriptPath,
      source: meta.source || 'unknown',
      updatedAt: lastTranscriptTimestamp(transcriptPath) || indexEntry?.updated_at || '',
      createdAt: '', // will be set below
    };

    // Try to get createdAt from file mtime if not available from transcript
    try {
      const stat = statSync(transcriptPath);
      session.createdAt = stat.birthtimeMs > 0 ? stat.birthtime.toISOString() : stat.mtime.toISOString();
      if (!session.updatedAt) session.updatedAt = session.createdAt;
    } catch {
      session.createdAt = session.updatedAt || new Date().toISOString();
    }

    sessions.push(session);
  }

  // Sort: cwd match first, then by updatedAt descending
  sessions.sort((a, b) => {
    if (cwd) {
      const aMatch = cwdMatch(a.cwd, cwd);
      const bMatch = cwdMatch(b.cwd, cwd);
      if (aMatch !== bMatch) return aMatch ? -1 : 1;
    }
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });

  return sessions.slice(0, limit);
}

/**
 * Check if two paths refer to the same directory.
 * Normalizes separators and resolves relative paths.
 */
function cwdMatch(sessionCwd: string, targetCwd: string): boolean {
  if (!sessionCwd || !targetCwd) return false;
  const normalize = (p: string) => path.resolve(p).toLowerCase().replace(/[/\\]+$/, '');
  return normalize(sessionCwd) === normalize(targetCwd);
}

/**
 * Get the most recent session for a specific workspace directory.
 * Returns null if no matching session found.
 */
export function findMostRecentSession(cwd: string): CodexLocalSession | null {
  const sessions = discoverLocalSessions(1, cwd);
  if (sessions.length === 0) return null;
  // Only return if cwd actually matches
  if (cwdMatch(sessions[0].cwd, cwd)) return sessions[0];
  return null;
}

/**
 * Find a transcript file by sessionId by scanning filenames (which contain the UUID).
 * More efficient than reading session_meta from every file.
 */
function findTranscriptBySessionId(dir: string, sessionId: string, depth: number): string | null {
  if (depth < 0) return null;
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = findTranscriptBySessionId(full, sessionId, depth - 1);
        if (found) return found;
      } else if (entry.isFile() && entry.name.includes(sessionId)) {
        return full;
      }
    }
  } catch { /* skip */ }
  return null;
}

/** Check if text is system-injected context (IDE state, open tabs, etc.). */
export function isSystemGeneratedContext(text: string): boolean {
  const t = text.trim();
  // Exact header patterns that mark system-injected context
  if (/^#\s*Context from my IDE/i.test(t)) return true;
  if (/^#\s*Setting up the workspace/i.test(t)) return true;
  if (t.startsWith('<environment_context>')) return true;
  if (t.startsWith('<permissions instructions>')) return true;
  // Structured file listings with open tabs and file paths
  if (t.indexOf('# Context') !== -1 && t.indexOf('Open tabs:') !== -1) return true;
  if (t.indexOf('AGENTS.md') !== -1 && t.indexOf('Context from') !== -1) return true;
  return false;
}

/**
 * Return only the user-visible part of Codex transcript text.
 *
 * Codex records host-injected context blocks (IDE open tabs, AGENTS.md, env
 * metadata) as normal user messages. Those are useful to the agent but noisy on
 * the phone; if a real request follows an IDE context block, keep only that.
 */
export function cleanCodexDisplayText(text: string): string {
  let t = text.replace(/\r\n/g, '\n').trim();
  if (!t) return '';

  const requestMatch = t.match(/##\s*My request for Codex:\s*([\s\S]*)$/i);
  if (requestMatch) {
    t = requestMatch[1].trim();
  }

  t = t
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, '')
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, '')
    .trim();

  if (!t) return '';
  if (isSystemGeneratedContext(t)) return '';
  if (/^#\s*AGENTS\.md instructions/i.test(t)) return '';
  if (/^#\s*Context from my IDE/i.test(t)) return '';
  if (/^<environment_context>/i.test(t)) return '';
  if (/^<permissions instructions>/i.test(t)) return '';
  return t;
}

export interface CodexConversationEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: string;
}

/**
 * Load recent conversation entries from a Codex transcript file.
 * Returns newest-first, up to maxEntries.
 * Efficient: searches transcripts directly by filename pattern rather than scanning all sessions.
 */
export function loadCodexConversation(sessionId: string, maxEntries = 10): CodexConversationEntry[] {
  // Find transcript directly by scanning for the sessionId in filenames
  const baseDir = path.join(codexConfigDir(), 'sessions');
  const transcriptPath = findTranscriptBySessionId(baseDir, sessionId, 6);
  if (!transcriptPath) return [];

  try {
    const text = readFileSync(transcriptPath, 'utf8');
    const lines = text.split('\n');
    const entries: CodexConversationEntry[] = [];
    let lastUserText = '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);

        // User message from response_item
        if (obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'user') {
          const content = obj.payload.content;
          let text = '';
          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part === 'object' && (part.type === 'input_text' || part.type === 'text') && part.text) {
                text += String(part.text) + ' ';
              }
            }
          } else if (typeof content === 'string') {
            text = content;
          }
          const trimmed = cleanCodexDisplayText(text);
          if (trimmed) {
            // Dedup consecutive user messages with same content
            if (trimmed === lastUserText) continue;
            lastUserText = trimmed;
            entries.push({ role: 'user', text: trimmed.slice(0, 200), timestamp: obj.timestamp });
          }
        }

        // Assistant message from response_item
        if (obj.type === 'response_item' && obj.payload?.type === 'message' && obj.payload?.role === 'assistant') {
          const content = obj.payload.content;
          let text = '';
          if (Array.isArray(content)) {
            for (const part of content) {
              if (typeof part === 'object' && (part.type === 'text' || part.type === 'output_text') && part.text) {
                text += String(part.text) + ' ';
              }
            }
          } else if (typeof content === 'string') {
            text = content;
          }
          const trimmed = cleanCodexDisplayText(text);
          if (trimmed) {
            entries.push({ role: 'assistant', text: trimmed.slice(0, 200), timestamp: obj.timestamp });
          }
        }

        // Event msg user/agent messages
        if (obj.type === 'event_msg') {
          if (obj.payload?.type === 'user_message' && typeof obj.payload.message === 'string') {
            const text = cleanCodexDisplayText(obj.payload.message);
            if (text) entries.push({ role: 'user', text: text.slice(0, 200), timestamp: obj.timestamp });
          }
          if (obj.payload?.type === 'agent_message' && typeof obj.payload.message === 'string') {
            const text = cleanCodexDisplayText(obj.payload.message);
            if (text) entries.push({ role: 'assistant', text: text.slice(0, 200), timestamp: obj.timestamp });
          }
        }
      } catch { /* skip malformed */ }
    }

    // Return newest first, limited to maxEntries
    entries.reverse();
    return entries.slice(0, maxEntries);
  } catch {
    return [];
  }
}
