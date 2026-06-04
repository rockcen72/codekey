import { execSync, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export type Platform = 'win32' | 'darwin' | 'linux';

/**
 * Single source of truth for platform detection.
 * Returns the Node.js process.platform narrowed to the three supported values.
 */
export function detectPlatform(): Platform {
  if (process.platform === 'win32') return 'win32';
  if (process.platform === 'darwin') return 'darwin';
  return 'linux';
}

/**
 * Map a binary name to its platform-specific filename.
 * win32 → name.exe, darwin/linux → name.
 */
export function binaryName(name: string): string {
  return detectPlatform() === 'win32' ? `${name}.exe` : name;
}

/**
 * Find a binary on PATH, returning its full path or null.
 *
 * Windows search order: name.exe → name.cmd → name.bat → name
 * (covers both native binaries and npm shims).
 *
 * macOS/Linux: delegates to `which`.
 *
 * Uses execFileSync with parameter arrays — no shell string concatenation.
 */
export function whichBinary(name: string): string | null {
  const platform = detectPlatform();

  if (platform === 'win32') {
    // Try extensions in priority order to catch both .exe and .cmd shims
    const exts = ['exe', 'cmd', 'bat', ''];
    for (const ext of exts) {
      const candidate = ext ? `${name}.${ext}` : name;
      try {
        const out = execFileSync('where', [candidate], {
          encoding: 'utf-8',
          timeout: 3000,
        });
        const line = out.split(/\r?\n/).map(s => s.trim()).find(Boolean);
        if (line && existsSync(line)) return line;
      } catch {
        // not found with this extension, try next
      }
    }
    return null;
  }

  // macOS / Linux
  try {
    const out = execFileSync('which', [name], {
      encoding: 'utf-8',
      timeout: 3000,
    });
    const line = out.trim().replace(/\r$/, '');
    if (line && existsSync(line)) return line;
    return null;
  } catch {
    return null;
  }
}

/**
 * Whether a script file needs `shell: true` when spawned on the current platform.
 * On win32, .cmd / .bat files require a shell; on POSIX they don't.
 */
export function needsShellForScript(file: string): boolean {
  if (detectPlatform() !== 'win32') return false;
  const lower = file.toLowerCase();
  return lower.endsWith('.cmd') || lower.endsWith('.bat');
}

/**
 * Discover a running OpenCode process's HTTP port by scanning process command lines.
 *
 * Search strategy (matches existing logic in bridge-entry.ts and
 * opencode-session-manager.ts):
 * 1. Try finding an `opencode` process with `--port <N>`
 * 2. Fallback: try `node` processes whose command line includes `opencode`
 *
 * Returns the port number, or null if not found.
 */
export function discoverOpenCodePort(): number | null {
  const platform = detectPlatform();

  try {
    let stdout: string;

    if (platform === 'win32') {
      // Try opencode binary first, then node.exe (for ts-node / node-based runs)
      for (const query of ['opencode', 'node']) {
        try {
          stdout = execSync(
            `wmic process where "name like '%${query}%'" get CommandLine /format:list`,
            { encoding: 'utf-8', timeout: 5000 },
          );
          const port = extractPortFromOutput(stdout);
          if (port !== null) return port;
        } catch { /* try next query */ }
      }
    } else {
      stdout = execSync(
        `ps aux | grep -v grep | grep -E "opencode|node.*opencode"`,
        { encoding: 'utf-8', timeout: 5000 },
      );
      return extractPortFromOutput(stdout);
    }
  } catch { /* fall through */ }

  return null;
}

/** Shared: extract the latest `--port <N>` from raw command-line output. */
function extractPortFromOutput(output: string): number | null {
  const all = [...output.matchAll(/--port\s+(\d+)/g)];
  if (all.length === 0) return null;
  return Number(all[all.length - 1][1]);
}

/**
 * List PIDs listening on a given TCP port.
 *
 * win32: parses `netstat -ano | findstr :PORT`
 * macOS/Linux: parses `lsof -ti :PORT`
 *
 * Returns an array of PID strings (may be empty).
 */
export function listPidsByPort(port: number): string[] {
  const platform = detectPlatform();

  try {
    if (platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port}`, {
        encoding: 'utf-8',
        timeout: 5000,
      });
      const pids = new Set<string>();
      for (const line of out.trim().split(/\r?\n/)) {
        const m = line.match(/(\d+)\s*$/);
        if (m && m[1]) pids.add(m[1]);
      }
      return [...pids];
    }

    // macOS / Linux
    const out = execSync(`lsof -ti :${port}`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return out.trim().split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Kill a process by PID.
 *
 * win32: `taskkill /F /PID <pid>`
 * macOS/Linux: `kill -9 <pid>`
 *
 * Uses execFileSync with parameter arrays (no shell string concatenation).
 */
export function killPid(pid: string): void {
  const platform = detectPlatform();

  try {
    if (platform === 'win32') {
      execFileSync('taskkill', ['/F', '/PID', pid], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    } else {
      execFileSync('kill', ['-9', pid], {
        encoding: 'utf-8',
        timeout: 5000,
      });
    }
  } catch {
    // Process may already be gone — best effort
  }
}

/**
 * Convenience: kill every process listening on `port`.
 * Combines listPidsByPort + killPid.
 */
export function killPort(port: number): void {
  const pids = listPidsByPort(port);
  for (const pid of pids) {
    killPid(pid);
  }
}
