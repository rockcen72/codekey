import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AuditEntry } from '@codekey/shared/bridge';

const AUDIT_DIR = path.join(os.homedir(), '.codekey');
const AUDIT_LOG_PATH = path.join(AUDIT_DIR, 'audit.log');
const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_BACKUP_FILES = 5;

/**
 * Write an audit entry to the local audit log.
 * Log file is at ~/.codekey/audit.log, JSON Lines format.
 * Automatically rotates when it exceeds MAX_LOG_SIZE.
 */
export function writeAuditLog(entry: AuditEntry): void {
  try {
    ensureDir();
    rotateIfNeeded();
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(AUDIT_LOG_PATH, line, 'utf-8');
  } catch (err) {
    // Audit failures are non-fatal — log but don't crash the bridge.
    console.error('[audit-log] write failed:', err);
  }
}

/**
 * Read the most recent N audit entries.
 */
export function readAuditLog(limit = 100): AuditEntry[] {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return [];
    const text = fs.readFileSync(AUDIT_LOG_PATH, 'utf-8');
    const lines = text.trim().split('\n').filter(Boolean);
    const entries: AuditEntry[] = [];
    for (const line of lines.slice(-limit)) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines silently.
      }
    }
    return entries;
  } catch {
    return [];
  }
}

/**
 * Clear the audit log.
 */
export function clearAuditLog(): void {
  try {
    ensureDir();
    fs.writeFileSync(AUDIT_LOG_PATH, '', 'utf-8');
  } catch (err) {
    console.error('[audit-log] clear failed:', err);
  }
}

/**
 * Get the audit log file path (for display in sidebar).
 */
export function getAuditLogPath(): string {
  return AUDIT_LOG_PATH;
}

export function getAuditLogDir(): string {
  return AUDIT_DIR;
}

/**
 * Create a safe AuditSink callback for the privacy pipeline.
 */
export function createAuditSink(): (entry: AuditEntry) => void {
  return (entry: AuditEntry) => writeAuditLog(entry);
}

// ── Internal ──

function ensureDir(): void {
  if (!fs.existsSync(AUDIT_DIR)) {
    fs.mkdirSync(AUDIT_DIR, { recursive: true });
  }
}

function rotateIfNeeded(): void {
  try {
    if (!fs.existsSync(AUDIT_LOG_PATH)) return;
    const stat = fs.statSync(AUDIT_LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;

    // Rotate: remove oldest, shift backups, rename current
    const oldest = path.join(AUDIT_DIR, `audit.log.${MAX_BACKUP_FILES}`);
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);

    for (let i = MAX_BACKUP_FILES - 1; i >= 1; i--) {
      const src = path.join(AUDIT_DIR, `audit.log.${i}`);
      if (fs.existsSync(src)) {
        fs.renameSync(src, path.join(AUDIT_DIR, `audit.log.${i + 1}`));
      }
    }

    fs.renameSync(AUDIT_LOG_PATH, path.join(AUDIT_DIR, 'audit.log.1'));
  } catch (err) {
    console.error('[audit-log] rotate failed:', err);
  }
}
