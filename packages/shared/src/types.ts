// ── Event Types ──────────────────────────────────────────

import type { InputRequiredEvent } from './bridge/input-card.js';

export type AgentType = 'claude-code' | 'claude-code-hook' | 'codex' | 'opencode' | 'generic-pty';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export type SessionStatus =
  | 'active'
  | 'paused'
  | 'awaiting_approval'
  | 'awaiting_reply'
  | 'completed'
  | 'error'
  | 'disconnected';

export type Decision = 'approve' | 'deny' | 'reply' | 'pause';

export type AgentEventType =
  | 'approval_required'
  | 'input_required'
  | 'question'
  | 'command_started'
  | 'command_finished'
  | 'task_complete'
  | 'diff_ready'
  | 'error'
  | 'heartbeat'
  | 'session_idle'
  | 'user_prompt';

// ── Event Data ──────────────────────────────────────────

export interface ApprovalEventData {
  action: 'run_command' | 'write_file' | 'modify_file' | 'unknown';
  command?: string;
  toolName?: string;
  cwd?: string;
  risk: RiskLevel;
  summary: string;
  contextSnippet?: string;
  diffSummary?: string;
}

export interface QuestionEventData {
  question: string;
  cwd?: string;
  contextSnippet?: string;
}

export interface CommandEventData {
  command: string;
  exitCode?: number;
  cwd?: string;
}

export interface ErrorEventData {
  message: string;
  code?: string;
  cwd?: string;
}

export interface UserPromptEventData {
  prompt: string;
  summary: string;
  timestamp?: string;
  index?: number;
}

export const MAX_PROMPT_LENGTH = 4000;

export interface DiffEventData {
  files: string[];
  summary: string;
}

export type AgentEventPayload =
  | ({ type: 'approval_required' } & ApprovalEventData)
  | InputRequiredEvent
  | ({ type: 'question' } & QuestionEventData)
  | ({ type: 'command_started' } & CommandEventData)
  | ({ type: 'command_finished' } & CommandEventData)
  | ({ type: 'task_complete' } & { summary: string; summaryShort?: string; output?: string })
  | ({ type: 'diff_ready' } & DiffEventData)
  | ({ type: 'error' } & ErrorEventData)
  | ({ type: 'heartbeat' } & Record<string, never>)
  | ({ type: 'session_idle' } & { idleMinutes: number })
  | ({ type: 'user_prompt' } & UserPromptEventData);

// ── Wire Protocol ──────────────────────────────────────

export interface SessionEventMessage {
  type: 'event';
  payload: {
    clientEventId?: string;    // ← for PC → server → event_ack roundtrip
    sessionId: string;
    agent: AgentType;
    eventType: AgentEventType;
    data: AgentEventPayload;
    ts: string;
  };
}

export interface ResponseMessage {
  type: 'response';
  payload: {
    sessionId: string;
    eventId: string;
    decision: Decision;
    message?: string;
    ts: string;
  };
}

export interface CommandMessage {
  type: 'command';
  payload: {
    sessionId: string;
    action: 'write_stdin' | 'pause_session' | 'resume_session';
    data: string;
  };
}

export interface EventPushMessage {
  type: 'event_push';
  payload: {
    sessionId: string;
    eventType: AgentEventType;
    summary: string;
    summaryShort?: string;
    risk?: RiskLevel;
  };
}

export interface QuotaExceededMessage {
  type: 'quota_exceeded';
  payload: {
    sessionId: string;
    /** Server-side event id (matches the row that was written to the events
     *  table for audit, even though the push was suppressed). */
    eventId: string;
    /** Bridge-supplied id (mirrors SessionEventMessage.payload.clientEventId).
     *  Null when the bridge didn't provide one. Lets the mini program
     *  correlate a quota toast with the specific blocked event. */
    clientEventId?: string | null;
    product: string;
    used: number;
    limit: number;
    /** "YYYY-MM" the count applies to. */
    period: string;
  };
}

export type WsMessage =
  | SessionEventMessage
  | ResponseMessage
  | CommandMessage
  | EventPushMessage
  | QuotaExceededMessage
  | { type: 'ping'; ts: string }
  | { type: 'pong'; ts: string }
  // Server → PC push messages
  | { type: 'approval_forward'; payload: { sessionId: string; eventId: string; decision: string; message: string } }
  | { type: 'event_ack'; payload: { clientEventId?: string | null; serverEventId: string } }
  | { type: 'session_registered'; payload: { sessionId: string; clientRequestId?: string | null; claudeSessionId?: string | null } }
  | { type: 'session_deactivated'; payload: { sessionId: string } }
  | { type: 'attached_sessions'; payload: { sessions: { id: string; claudeSessionId: string | null }[] } }
  | { type: 'pairing_ready'; payload: { deviceId: string } }
  | { type: 'device_token'; payload: { deviceToken: string; deviceId: string; phonePublicKeyHex?: string; e2eAvailable?: boolean } }
  | { type: 'mp_online' }
  | { type: 'mp_offline' }
  | { type: 'error'; payload: { code: string } }
  // Server → client auth failure (device replaced / unbound)
  | { type: 'auth_failed'; code?: string; payload?: { code?: string } }
  // Raw-only client-originated messages (sent via sendRaw, not typed serialization):
  | { type: 'attach_session'; payload: { sessionId: string; claudeSessionId: string; metadata?: SessionMetadataPayload } }
  | { type: 'detach_session'; payload: { sessionId: string } }
  | { type: 'query_attached_sessions' }
  // History Share Policy (Phase 2)
  | { type: 'sync_history_policy'; payload: { key: string; config?: { policy: string; recentCount?: number; updatedAt: number }; action?: 'set' | 'delete' } };

// ── Device Pairing ─────────────────────────────────────

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  publicKey?: string;
  boundTo?: string;
  lastSeenAt?: string;
}

export interface PairingCode {
  code: string;
  expiresAt: string;
}

export interface SessionMetadataPayload {
  claudeSessionId?: string;
  runtime?: 'claude-code';
  title?: string;
  cwd?: string;
  source?: 'hook' | 'transcript_attach' | 'managed_acp' | 'provisional_tab';
  windowId?: string;
  attachedAt?: string;
  lastHookAt?: string;
}
