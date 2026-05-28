import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
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

export async function listRecentClaudeTranscripts(limit = 20): Promise<ClaudeTranscriptMetadata[]> {
  const baseDir = claudeConfigDir();
  const projectsDir = path.join(baseDir, 'projects');

  let entries: { file: string; mtime: number }[];
  try {
    const dirs = readdirSync(projectsDir, { withFileTypes: true });
    entries = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const dirPath = path.join(projectsDir, dir.name);
      const files = readdirSync(dirPath);
      for (const file of files) {
        if (!file.endsWith('.jsonl')) continue;
        const fullPath = path.join(dirPath, file);
        try {
          const st = statSync(fullPath);
          entries.push({ file: fullPath, mtime: st.mtimeMs });
        } catch {
          // skip inaccessible files
        }
      }
    }
  } catch {
    return [];
  }

  entries.sort((a, b) => b.mtime - a.mtime);
  entries = entries.slice(0, Math.max(1, Math.min(limit, 100)));

  const sessions: ClaudeTranscriptMetadata[] = [];
  for (const item of entries) {
    const sessionId = path.basename(item.file, '.jsonl');
    const lines: string[] = [];
    const reader = readline.createInterface({
      input: createReadStream(item.file, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const line of reader) {
      if (line.trim()) lines.push(line);
      if (lines.length >= 200) break;
    }
    sessions.push(parseClaudeTranscriptLines(lines, sessionId, item.file));
  }
  return sessions;
}
