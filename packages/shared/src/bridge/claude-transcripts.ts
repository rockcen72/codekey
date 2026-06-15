import { createReadStream, existsSync, readdirSync, statSync, fstatSync, openSync, readSync, closeSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

export interface ClaudeTranscriptMetadata {
  sessionId: string;
  cwd: string;
  title: string;
  transcriptPath: string;
  createdAt: string;
  updatedAt: string;
}

interface TranscriptLine {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  session_id?: string;
  cwd?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: unknown;
  };
}

export function claudeConfigDir(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(homedir(), '.claude');
}

export function escapeClaudeProjectDir(workDir: string): string {
  return path.normalize(workDir.trim()).replace(/[\\/:]+/g, '-');
}

export function transcriptPathFor(workDir: string, sessionId: string): string {
  return path.join(claudeConfigDir(), 'projects', escapeClaudeProjectDir(workDir), `${sessionId.trim()}.jsonl`);
}

export function findTranscriptPath(sessionId: string): string | null {
  const sid = sessionId.trim();
  if (!sid) return null;
  const projectsDir = path.join(claudeConfigDir(), 'projects');
  let dirs: string[];
  try {
    dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const filePath = path.join(projectsDir, dir, `${sid}.jsonl`);
    if (existsSync(filePath)) return filePath;
  }
  return null;
}

/** Sync helper: read the start of a transcript to extract the cwd field. */
export function resolveTranscriptCwd(sessionId: string): string | null {
  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) return null;
  try {
    const fd = openSync(transcriptPath, 'r');
    try {
      // Read first 64KB — early metadata lines can be large (hook_success attachment)
      const buf = Buffer.alloc(65536);
      const bytesRead = readSync(fd, buf, 0, 65536, 0);
      const text = buf.toString('utf8', 0, bytesRead);
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (!lines[i].trim()) continue;
        try {
          const obj = JSON.parse(lines[i]);
          if (obj.cwd) return obj.cwd.trim();
        } catch { /* skip malformed — may be truncated at buffer boundary */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore */ }
  return null;
}

export async function resolveClaudeTranscript(sessionId: string): Promise<ClaudeTranscriptMetadata | null> {
  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath || !existsSync(transcriptPath)) return null;

  const lines: string[] = [];
  const reader = readline.createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of reader) {
    if (line.trim()) lines.push(line);
  }

  return parseClaudeTranscriptLines(lines, sessionId, transcriptPath);
}

export function parseClaudeTranscriptLines(
  lines: string[],
  requestedSessionId: string,
  transcriptPath: string,
): ClaudeTranscriptMetadata {
  let sessionId = requestedSessionId.trim();
  let cwd = '';
  let title = '';
  let createdAt = '';
  let updatedAt = '';

  for (const raw of lines) {
    let line: TranscriptLine;
    try {
      line = JSON.parse(raw) as TranscriptLine;
    } catch {
      continue;
    }

    sessionId ||= line.sessionId?.trim() || line.session_id?.trim() || '';
    if (!cwd && line.cwd) cwd = line.cwd.trim();

    const ts = normalizeTimestamp(line.timestamp);
    if (ts) {
      if (!createdAt) createdAt = ts;
      updatedAt = ts;
    }

    if (!title) {
      const candidate = titleFromLine(line);
      if (candidate) title = candidate;
    }
  }

  if (!sessionId) sessionId = requestedSessionId.trim();
  if (!title) title = sessionId;
  if (!updatedAt && existsSync(transcriptPath)) {
    updatedAt = statSync(transcriptPath).mtime.toISOString();
  }
  if (!createdAt) createdAt = updatedAt || new Date().toISOString();
  if (!updatedAt) updatedAt = createdAt;

  return { sessionId, cwd, title, transcriptPath, createdAt, updatedAt };
}

export function stripContextTags(text: string): string {
  // Claude Code prepends <ide_opened_file>path</ide_opened_file> etc.
  // Strip all leading XML‑like context tags to get the actual user message.
  return text.replace(/^(<\w+>[^<]*<\/\w+>\s*)+/, '').trim();
}

function titleFromLine(line: TranscriptLine): string {
  if (line.type !== 'user' || line.isMeta || !line.message) return '';
  if (line.message.role && line.message.role !== 'user') return '';
  const title = compactWhitespace(extractText(line.message.content));
  if (isControlOnlyTitle(title)) return '';
  return stripContextTags(title);
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(extractText).filter(Boolean).join(' ');
  if (content && typeof content === 'object') {
    const obj = content as Record<string, unknown>;
    if (obj.type === 'tool_result' || obj.type === 'tool_use') return '';
    if (typeof obj.text === 'string') return obj.text;
    return extractText(obj.content);
  }
  return '';
}

function isControlOnlyTitle(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return true;
  if (trimmed.startsWith('/') && !trimmed.includes(' ')) return true;
  return [
    '<local-command-caveat>',
    '<local-command-stdout>',
    '<local-command-stderr>',
    '<command-name>',
    '<command-message>',
    '<command-args>',
  ].some((marker) => trimmed.includes(marker));
}

export function compactWhitespace(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function normalizeTimestamp(raw?: string): string {
  if (!raw) return '';
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toISOString();
}

export interface UserPromptEntry {
  text: string;
  timestamp: string;
  index: number;
}

export interface ConversationEntry {
  role: 'user' | 'assistant';
  text: string;
  timestamp: string;
  index: number;
}

/**
 * Load a full transcript conversation as user/assistant message pairs.
 * Filters out tool_use/tool_result blocks and system messages.
 * Returns entries in chronological order, most recent last.
 */
export function loadConversation(sessionId: string, maxEntries = 100): ConversationEntry[] {
  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) return [];

  const text = readFileSync(transcriptPath, 'utf8');
  const lines = text.split('\n');
  const entries: ConversationEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw) continue;
    let obj: TranscriptLine;
    try {
      obj = JSON.parse(raw);
    } catch { continue; }

    if (obj.type === 'user' && !obj.isMeta && obj.message?.role === 'user') {
      const rawText = extractText(obj.message.content);
      if (rawText) {
        const text = compactWhitespace(stripContextTags(rawText));
        if (!isControlOnlyTitle(text)) {
          entries.push({ role: 'user', text, timestamp: normalizeTimestamp(obj.timestamp), index: i });
        }
      }
    } else if (obj.type === 'assistant' && obj.message?.role === 'assistant') {
      const rawText = extractText(obj.message.content);
      if (rawText) {
        entries.push({
          role: 'assistant',
          text: compactWhitespace(rawText),
          timestamp: normalizeTimestamp(obj.timestamp),
          index: i,
        });
      }
    }
  }

  if (entries.length > maxEntries) return entries.slice(entries.length - maxEntries);
  return entries;
}

export async function extractUserPrompts(
  sessionId: string,
  maxCount = 20,
): Promise<UserPromptEntry[]> {
  const transcriptPath = findTranscriptPath(sessionId);
  if (!transcriptPath) return [];

  const reader = readline.createInterface({
    input: createReadStream(transcriptPath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  const lines: string[] = [];
  for await (const line of reader) {
    if (line.trim()) lines.push(line);
  }

  const prompts: UserPromptEntry[] = [];
  for (let i = 0; i < lines.length; i++) {
    let line: TranscriptLine;
    try {
      line = JSON.parse(lines[i]) as TranscriptLine;
    } catch {
      continue;
    }
    if (line.type !== 'user' || line.isMeta) continue;
    if (line.message?.role && line.message.role !== 'user') continue;
    const rawText = extractText(line.message?.content);
    if (!rawText) continue;
    const text = compactWhitespace(stripContextTags(rawText));
    if (isControlOnlyTitle(text)) continue;
    prompts.push({
      text,
      timestamp: normalizeTimestamp(line.timestamp),
      index: i,
    });
  }

  // Take last maxCount, keep old→new order
  const start = Math.max(0, prompts.length - maxCount);
  return prompts.slice(start);
}

/** Read the last ~64KB of a JSONL file and return the latest timestamp found. */
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
            const ts = normalizeTimestamp(line.timestamp);
            if (ts) return ts;
          }
        } catch { /* skip malformed lines */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore */ }
  return '';
}

/** Read the transcript tail and return the latest meaningful user prompt as a local display title. */
function lastTranscriptTitle(filePath: string): string {
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
          const title = titleFromLine(JSON.parse(lines[i]) as TranscriptLine);
          if (title) return title;
        } catch { /* skip malformed or partial tail lines */ }
      }
    } finally {
      closeSync(fd);
    }
  } catch { /* ignore */ }
  return '';
}

export async function listRecentClaudeTranscripts(limit = 5): Promise<ClaudeTranscriptMetadata[]> {
  const baseDir = claudeConfigDir();
  const projectsDir = path.join(baseDir, 'projects');

  // Collect all .jsonl files
  const files: string[] = [];
  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true });
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(projectsDir, dir.name);
      for (const file of readdirSync(dirPath)) {
        if (!file.endsWith('.jsonl')) continue;
        files.push(path.join(dirPath, file));
      }
    }
  } catch {
    return [];
  }

  // Parse each file (first 200 lines for metadata) and sort by last timestamp
  const sessions: ClaudeTranscriptMetadata[] = [];
  for (const fullPath of files) {
    const sessionId = path.basename(fullPath, '.jsonl');
    const lines: string[] = [];
    const reader = readline.createInterface({
      input: createReadStream(fullPath, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      if (line.trim()) lines.push(line);
      if (lines.length >= 200) break;
    }
    const meta = parseClaudeTranscriptLines(lines, sessionId, fullPath);
    const tailTitle = lastTranscriptTitle(fullPath);
    if (tailTitle) meta.title = tailTitle;
    // Override updatedAt with the file's LAST timestamp (newest activity).
    // parseClaudeTranscriptLines only sees the first 200 lines, which are the
    // OLDEST lines — new lines are appended to the end. Reading the tail gives
    // us the real latest activity for correct newest-first ordering.
    const lastTs = lastTranscriptTimestamp(fullPath);
    if (lastTs) {
      meta.updatedAt = lastTs;
    } else {
      // Fallback to file's modification time if tail read fails (e.g. file lock race on Windows)
      try { meta.updatedAt = statSync(fullPath).mtime.toISOString(); } catch {}
    }
    sessions.push(meta);
  }

  // Dedup by sessionId: if same session in multiple project dirs, keep newest updatedAt
  const dedupMap = new Map<string, ClaudeTranscriptMetadata>();
  for (const s of sessions) {
    const existing = dedupMap.get(s.sessionId);
    if (!existing || s.updatedAt > existing.updatedAt) {
      dedupMap.set(s.sessionId, s);
    }
  }
  const unique = Array.from(dedupMap.values());

  // Sort by updatedAt (transcript content timestamp), newest first
  unique.sort((a, b) => {
    const ta = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
    const tb = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
    return tb - ta;
  });
  return unique.slice(0, Math.max(1, Math.min(limit, 100)));
}
