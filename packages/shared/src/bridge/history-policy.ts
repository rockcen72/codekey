export enum HistorySharePolicy {
  Off = 'off',
  Minimal = 'minimal',
  Recent = 'recent',
  Sanitized = 'sanitized',
  Manual = 'manual',
}

export interface HistoryPolicyConfig {
  policy: HistorySharePolicy;
  recentCount?: number;
  updatedAt: number;
}

export const DEFAULT_HISTORY_SHARE_POLICY = HistorySharePolicy.Off;
export const DEFAULT_RECENT_COUNT = 10;
export const MIN_RECENT_COUNT = 1;
export const MAX_RECENT_COUNT = 50;
export const SANITIZED_ALLOWED_FIELDS = ['summary', 'metadata', 'status', 'basename'] as const;

export type AgentType = 'claude' | 'codex' | 'opencode' | string;
export type PolicyKey = `${AgentType}:${string}` | AgentType | '*';

export interface PolicyResult {
  allowed: boolean;
  maxCount?: number;
  allowedFields?: readonly string[];
}

export function sanitizeRecentCount(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < MIN_RECENT_COUNT || n > MAX_RECENT_COUNT) {
    return DEFAULT_RECENT_COUNT;
  }
  return n;
}

interface PendingWaiter { resolve: () => void; timer: NodeJS.Timeout; }

const pendingReplayQueue = new Map<PolicyKey, PendingWaiter[]>();
const configMap = new Map<PolicyKey, HistoryPolicyConfig>();

export function getConfig(key: PolicyKey): HistoryPolicyConfig {
  return configMap.get(key) ?? { policy: DEFAULT_HISTORY_SHARE_POLICY, updatedAt: 0 };
}

export function getAllConfigs(): Array<{ key: PolicyKey; config: HistoryPolicyConfig }> {
  const result: Array<{ key: PolicyKey; config: HistoryPolicyConfig }> = [];
  for (const [key, config] of configMap) {
    result.push({ key, config });
  }
  return result;
}

export function setConfig(key: PolicyKey, config: HistoryPolicyConfig): void {
  configMap.set(key, {
    ...config,
    recentCount: config.recentCount !== undefined ? sanitizeRecentCount(config.recentCount) : undefined,
    updatedAt: config.updatedAt || Date.now(),
  });
  onPolicySynced(key);
}

export function deleteConfig(key: PolicyKey): void {
  configMap.delete(key);
}

export function checkHistoryPolicy(localSessionId: string, agentType: string): PolicyResult {
  const key: PolicyKey = `${agentType}:${localSessionId}`;
  const cfg = configMap.get(key)
    ?? configMap.get(agentType as PolicyKey)
    ?? configMap.get('*')
    ?? { policy: DEFAULT_HISTORY_SHARE_POLICY, recentCount: DEFAULT_RECENT_COUNT, updatedAt: 0 };

  if (cfg.policy === HistorySharePolicy.Off) return { allowed: false };
  if (cfg.policy === HistorySharePolicy.Minimal) return { allowed: false };
  if (cfg.policy === HistorySharePolicy.Recent) return { allowed: true, maxCount: cfg.recentCount ?? DEFAULT_RECENT_COUNT };
  if (cfg.policy === HistorySharePolicy.Sanitized) return {
    allowed: true,
    maxCount: cfg.recentCount ?? DEFAULT_RECENT_COUNT,
    allowedFields: SANITIZED_ALLOWED_FIELDS,
  };
  return { allowed: false };
}

export function waitForPolicy(key: PolicyKey): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const arr = pendingReplayQueue.get(key);
      if (arr) {
        const idx = arr.findIndex(w => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) pendingReplayQueue.delete(key);
      }
      resolve();
    }, 15_000);
    const entry: PendingWaiter = { resolve: () => { clearTimeout(timer); resolve(); }, timer };
    const arr = pendingReplayQueue.get(key) ?? [];
    arr.push(entry);
    pendingReplayQueue.set(key, arr);
  });
}

function onPolicySynced(key: PolicyKey): void {
  const arr = pendingReplayQueue.get(key);
  if (arr) {
    for (const w of arr) w.resolve();
    pendingReplayQueue.delete(key);
  }
}
