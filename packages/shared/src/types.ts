// ── Event Types ──────────────────────────────────────────

export type AgentType = 'claude-code' | 'codex' | 'opencode' | 'generic-pty';

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
  | 'question'
  | 'command_started'
  | 'command_finished'
  | 'task_complete'
  | 'diff_ready'
  | 'error'
  | 'heartbeat'
  | 'session_idle';

// ── Event Data ──────────────────────────────────────────

export interface ApprovalEventData {
  action: 'run_command' | 'write_file' | 'modify_file' | 'unknown';
  command?: string;
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

export interface DiffEventData {
  files: string[];
  summary: string;
}

export type AgentEventPayload =
  | ({ type: 'approval_required' } & ApprovalEventData)
  | ({ type: 'question' } & QuestionEventData)
  | ({ type: 'command_started' } & CommandEventData)
  | ({ type: 'command_finished' } & CommandEventData)
  | ({ type: 'task_complete' } & { summary: string })
  | ({ type: 'diff_ready' } & DiffEventData)
  | ({ type: 'error' } & ErrorEventData)
  | ({ type: 'heartbeat' } & Record<string, never>)
  | ({ type: 'session_idle' } & { idleMinutes: number });

// ── Wire Protocol ──────────────────────────────────────

export interface SessionEventMessage {
  type: 'event';
  payload: {
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
    risk?: RiskLevel;
  };
}

export type WsMessage =
  | SessionEventMessage
  | ResponseMessage
  | CommandMessage
  | EventPushMessage
  | { type: 'ping'; ts: string }
  | { type: 'pong'; ts: string };

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
