import { describe, it, expect, beforeEach } from 'vitest';
import {
  HistorySharePolicy,
  checkHistoryPolicy,
  getConfig,
  getAllConfigs,
  getEffectiveConfig,
  setConfig,
  deleteConfig,
  sanitizeRecentCount,
  waitForPolicy,
  DEFAULT_HISTORY_SHARE_POLICY,
  DEFAULT_RECENT_COUNT,
  MIN_RECENT_COUNT,
  MAX_RECENT_COUNT,
  SANITIZED_ALLOWED_FIELDS,
} from '../bridge/history-policy.js';

// configMap is module-scoped; each test file gets a fresh instance via vitest isolation
describe('history-policy', () => {

  beforeEach(() => {
    // Clean up any config entries set by previous tests
    for (const { key } of getAllConfigs()) {
      deleteConfig(key);
    }
  });

  it('uses a fixed recent history count of 10', () => {
    expect(DEFAULT_RECENT_COUNT).toBe(10);
  });

  // ── API shape: getAllConfigs ─────────────────────
  describe('getAllConfigs', () => {
    it('returns empty array when no configs set', () => {
      expect(getAllConfigs()).toEqual([]);
    });

    it('returns { key, config } objects where config has .policy', () => {
      setConfig('opencode', { policy: HistorySharePolicy.Recent, recentCount: 99, updatedAt: 100 });
      const all = getAllConfigs();
      expect(all).toHaveLength(1);
      expect(all[0]).toHaveProperty('key', 'opencode');
      expect(all[0]).toHaveProperty('config');
      expect(all[0].config).toHaveProperty('policy', HistorySharePolicy.Recent);
      expect(all[0].config).not.toHaveProperty('recentCount');
      expect(all[0].config).toHaveProperty('updatedAt');
      // NOT flat { key, policy }
      expect((all[0] as any).policy).toBeUndefined();
    });

    it('returns multiple entries', () => {
      setConfig('*', { policy: HistorySharePolicy.Off, updatedAt: 1 });
      setConfig('codex', { policy: HistorySharePolicy.Recent, recentCount: 3, updatedAt: 2 });
      const all = getAllConfigs();
      expect(all).toHaveLength(2);
      expect(all.find(c => c.key === '*')!.config.policy).toBe(HistorySharePolicy.Off);
      expect(all.find(c => c.key === 'codex')!.config.recentCount).toBeUndefined();
    });
  });

  // ── getEffectiveConfig fallback ──────────────────
  describe('getEffectiveConfig', () => {
    it('returns agent-level config when set', () => {
      setConfig('codex', { policy: HistorySharePolicy.Recent, recentCount: 7, updatedAt: 10 });
      const cfg = getEffectiveConfig('codex');
      expect(cfg.policy).toBe(HistorySharePolicy.Recent);
      expect(cfg.recentCount).toBeUndefined();
    });

    it('falls back to * when agent-level is not set', () => {
      setConfig('*', { policy: HistorySharePolicy.Sanitized, recentCount: 15, updatedAt: 20 });
      const cfg = getEffectiveConfig('codex');
      expect(cfg.policy).toBe(HistorySharePolicy.Sanitized);
      expect(cfg.recentCount).toBeUndefined();
    });

    it('falls back to default when no config exists', () => {
      const cfg = getEffectiveConfig('claude-code-hook');
      expect(cfg.policy).toBe(DEFAULT_HISTORY_SHARE_POLICY);
      expect(cfg.recentCount).toBeUndefined();
    });

    it('prefers agent-level over * when both are set', () => {
      setConfig('*', { policy: HistorySharePolicy.Sanitized, recentCount: 5, updatedAt: 1 });
      setConfig('codex', { policy: HistorySharePolicy.Recent, recentCount: 3, updatedAt: 2 });
      const cfg = getEffectiveConfig('codex');
      expect(cfg.policy).toBe(HistorySharePolicy.Recent);
      expect(cfg.recentCount).toBeUndefined();
    });

    it('does NOT consider per-session overrides', () => {
      setConfig('codex:session-abc', { policy: HistorySharePolicy.Recent, recentCount: 9, updatedAt: 30 });
      // getEffectiveConfig('codex') should NOT see per-session key
      const cfg = getEffectiveConfig('codex');
      expect(cfg.policy).toBe(DEFAULT_HISTORY_SHARE_POLICY);
    });
  });

  // ── checkHistoryPolicy fallback chain ────────────
  describe('checkHistoryPolicy', () => {
    it('uses per-session override with fixed recent count when available', () => {
      setConfig('codex:session-abc', { policy: HistorySharePolicy.Recent, recentCount: 2, updatedAt: 1 });
      const r = checkHistoryPolicy('session-abc', 'codex');
      expect(r.allowed).toBe(true);
      expect(r.maxCount).toBe(DEFAULT_RECENT_COUNT);
    });

    it('falls back to agent-level', () => {
      setConfig('codex', { policy: HistorySharePolicy.Sanitized, recentCount: 8, updatedAt: 1 });
      const r = checkHistoryPolicy('session-xyz', 'codex');
      expect(r.allowed).toBe(true);
      expect(r.allowedFields).toBe(SANITIZED_ALLOWED_FIELDS);
    });

    it('falls back to *', () => {
      setConfig('*', { policy: HistorySharePolicy.Recent, recentCount: 4, updatedAt: 1 });
      const r = checkHistoryPolicy('session-any', 'unknown-agent');
      expect(r.allowed).toBe(true);
      expect(r.maxCount).toBe(DEFAULT_RECENT_COUNT);
    });

    it('returns not allowed (Off) when no config set', () => {
      const r = checkHistoryPolicy('session-foo', 'claude-code-hook');
      expect(r.allowed).toBe(false);
      expect(r.maxCount).toBeUndefined();
    });

    it('Sanitized returns allowedFields', () => {
      setConfig('*', { policy: HistorySharePolicy.Sanitized, recentCount: 10, updatedAt: 1 });
      const r = checkHistoryPolicy('s', 'codex');
      expect(r.allowed).toBe(true);
      expect(r.maxCount).toBe(DEFAULT_RECENT_COUNT);
      // Audit r2 P1-B: encryption envelope markers must survive Sanitized projection
      // so phone-side decryption logic still sees the encrypted=true / safe_summary
      // / preview_label / encryption_error markers.
      expect(r.allowedFields).toEqual([
        'type',
        'summary',
        'summaryShort',
        'status',
        'encrypted',
        'safe_summary',
        'preview_label',
        'encryption_error',
      ]);
    });

    it('per-session overrides agent-level', () => {
      setConfig('codex', { policy: HistorySharePolicy.Off, updatedAt: 1 });
      setConfig('codex:session-1', { policy: HistorySharePolicy.Recent, recentCount: 5, updatedAt: 2 });
      const r = checkHistoryPolicy('session-1', 'codex');
      expect(r.allowed).toBe(true);
      expect(r.maxCount).toBe(DEFAULT_RECENT_COUNT);
    });
  });

  // ── sanitizeRecentCount ──────────────────────────
  describe('sanitizeRecentCount', () => {
    it('passes valid values through', () => {
      expect(sanitizeRecentCount(1)).toBe(1);
      expect(sanitizeRecentCount(10)).toBe(10);
      expect(sanitizeRecentCount(50)).toBe(50);
    });

    it('clamps below MIN to DEFAULT', () => {
      expect(sanitizeRecentCount(0)).toBe(DEFAULT_RECENT_COUNT);
      expect(sanitizeRecentCount(-5)).toBe(DEFAULT_RECENT_COUNT);
    });

    it('clamps above MAX to DEFAULT', () => {
      expect(sanitizeRecentCount(51)).toBe(DEFAULT_RECENT_COUNT);
      expect(sanitizeRecentCount(999)).toBe(DEFAULT_RECENT_COUNT);
    });

    it('rejects non-integers', () => {
      expect(sanitizeRecentCount(3.5)).toBe(DEFAULT_RECENT_COUNT);
      expect(sanitizeRecentCount(NaN)).toBe(DEFAULT_RECENT_COUNT);
    });

    it('rejects non-numeric', () => {
      expect(sanitizeRecentCount('10' as any)).toBe(DEFAULT_RECENT_COUNT);
      expect(sanitizeRecentCount(null)).toBe(DEFAULT_RECENT_COUNT);
      expect(sanitizeRecentCount(undefined)).toBe(DEFAULT_RECENT_COUNT);
    });
  });

  // ── SetConfig ignores custom recentCount ─────────
  describe('setConfig', () => {
    it('drops custom recentCount because sharing always uses the fixed default', () => {
      setConfig('codex', { policy: HistorySharePolicy.Recent, recentCount: 999, updatedAt: 1 });
      const cfg = getConfig('codex');
      expect(cfg.recentCount).toBeUndefined();
    });

    it('allows undefined recentCount', () => {
      setConfig('codex', { policy: HistorySharePolicy.Off, updatedAt: 1 });
      const cfg = getConfig('codex');
      expect(cfg.recentCount).toBeUndefined();
    });

    it('sets updatedAt to Date.now() when not provided', () => {
      const before = Date.now();
      setConfig('codex', { policy: HistorySharePolicy.Recent, recentCount: 3 } as any);
      const cfg = getConfig('codex');
      expect(cfg.updatedAt).toBeGreaterThanOrEqual(before);
    });
  });

  // ── CRUD ─────────────────────────────────────────
  describe('CRUD', () => {
    it('getConfig returns default for unknown key', () => {
      const cfg = getConfig('nonexistent' as any);
      expect(cfg.policy).toBe(DEFAULT_HISTORY_SHARE_POLICY);
      expect(cfg.updatedAt).toBe(0);
    });

    it('setConfig + getConfig round-trips', () => {
      setConfig('codex', { policy: HistorySharePolicy.Sanitized, recentCount: 3, updatedAt: 42 });
      const cfg = getConfig('codex');
      expect(cfg.policy).toBe(HistorySharePolicy.Sanitized);
      expect(cfg.recentCount).toBeUndefined();
      expect(cfg.updatedAt).toBe(42);
    });

    it('deleteConfig removes entry', () => {
      setConfig('codex', { policy: HistorySharePolicy.Recent, recentCount: 5, updatedAt: 1 });
      deleteConfig('codex');
      expect(getConfig('codex').policy).toBe(DEFAULT_HISTORY_SHARE_POLICY);
    });
  });

  // ── waitForPolicy times out after 15s ────────────
  describe('waitForPolicy', () => {
    it('resolves when setConfig is called for the same key', async () => {
      const p = waitForPolicy('codex');
      setConfig('codex', { policy: HistorySharePolicy.Recent, recentCount: 3, updatedAt: 1 });
      await expect(p).resolves.toBeUndefined();
    });

    it('resolves after timeout when no setConfig arrives', async () => {
      const p = waitForPolicy('unused-key');
      await expect(p).resolves.toBeUndefined();
    }, 20_000); // allow extra time for the 15s timeout
  });
});
