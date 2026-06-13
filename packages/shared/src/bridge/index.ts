export { ApprovalBridge } from './handler.js';
export type { HookEventBody, ApprovalResponder, CommandHandler } from './handler.js';
export { RiskEngine } from '../risk.js';
export { startBridgeServer } from './server.js';
export { RelayClient } from './relay-client.js';
export { CommandQueue } from './command-queue.js';
export type { PendingCommand } from './command-queue.js';
export { resolveCodexBinary } from './codex-binary.js';
export type { CodexBinarySearchOptions } from './codex-binary.js';
export { CodexAppServerClient } from './codex-app-server-client.js';
export type { ServerRequestMessage, RequestId, CodexAppServerClientOptions } from './codex-app-server-client.js';
export { toCodexDecision, isApprovalMethod, isInputMethod } from './codex-decision.js';
export type { CodexReviewDecision, CodexServerRequestMethod } from './codex-decision.js';
export { formatInputRequiredEvent, parseInputReply, tryFormatInputRequiredEvent } from './input-card.js';
export type { InputOption, InputQuestion, InputRequiredEvent } from './input-card.js';

export { CodexRelay } from './codex-relay.js';

export { loadConversation } from './claude-transcripts.js';

// Codex Resume Runtime (P0.5 + P1)
export { discoverLocalSessions, findMostRecentSession, codexConfigDir, loadCodexConversation, isSystemGeneratedContext, normalizeCodexSessionTitle } from './codex-local-session-resolver.js';
export type { CodexLocalSession, CodexConversationEntry } from './codex-local-session-resolver.js';

export { CodexResumeRuntime } from './codex-resume-runtime.js';
export type { ResumeResult, ResumeEvent, CodexResumeRuntimeOptions } from './codex-resume-runtime.js';

export { CodexTranscriptWatcher } from './codex-transcript-watcher.js';
export type { TranscriptEvent, CodexTranscriptWatcherOptions } from './codex-transcript-watcher.js';

export { CodexResumeManager } from './codex-resume-manager.js';
export { OpenCodeSessionManager } from './opencode-session-manager.js';

// Privacy pipeline
export { runPrivacyPipeline, toCheckedPayload, projectAllowedFields, projectHistoryEventForPolicy, safeSummary, type PrivacyContext, type PrivacyDecision, type PrivacyCheckedPayload, type AuditEntry, type AuditSink, type SourceType, type ContentPolicy } from './privacy-pipeline.js';
export { scan, replace, scanAndReplace, type Finding, type Rule } from './secret-scanner.js';
export { CodeKeyIgnore } from './codekeyignore.js';
export { DEFAULT_BLOCKED_PATTERNS, matchesAny } from './blocklist.js';
export {
  detectPlatform,
  binaryName,
  whichBinary,
  needsShellForScript,
  discoverOpenCodePort,
  listPidsByPort,
  killPid,
  killPort,
} from './platform.js';
export type { Platform } from './platform.js';

// History Share Policy (Phase 2)
export {
  HistorySharePolicy,
  checkHistoryPolicy,
  getConfig,
  getEffectiveConfig,
  getAllConfigs,
  setConfig,
  deleteConfig,
  waitForPolicy,
  sanitizeRecentCount,
  DEFAULT_HISTORY_SHARE_POLICY,
  DEFAULT_RECENT_COUNT,
  MIN_RECENT_COUNT,
  MAX_RECENT_COUNT,
  SANITIZED_ALLOWED_FIELDS,
} from './history-policy.js';
export type {
  HistoryPolicyConfig,
  PolicyKey,
  PolicyResult,
  AgentType,
} from './history-policy.js';
