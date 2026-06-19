export interface UserSession {
  id: string;
  device_id: string;
  device_name?: string;
  agent_type: string;
  status: 'active' | 'paused' | 'finished';
  pending_count: number;
  metadata: {
    claudeSessionId?: string;
    runtime?: string;
    title?: string;
    cwd?: string;
    source?: string;
    windowId?: string;
  };
  created_at: string;
  last_active_at: string;
  finished_at?: string | null;
}

export interface UserDevice {
  id: string;
  device_name: string;
  bound_at: string;
}

export interface UserEvent {
  id: string;
  session_id: string;
  type: string;
  role?: 'user' | 'assistant' | 'agent' | null;
  data: unknown;
  risk_level: string | null;
  pending: boolean;
  decision: string | null;
  created_at: string;
  // E2E encryption envelope (Phase 4+) — server passes through sealed_payload/key_id/encryption_version
  // when PC encrypted the event. data on encrypted events only carries allowlist fields
  // (type, encrypted, safe_summary, preview_label) — actual body is in sealed_payload.
  sealed_payload?: string | null;
  key_id?: string | null;
  encryption_version?: number | null;
}

export interface SubscriptionStatus {
  tier: 'free' | 'trial' | 'paid';
  plan: string | null;
  expiresAt: string | null;
  product: string;
  usage: { used: number; limit: number } | null;
  source?: string;
  nextBillingTime?: string | null;
  cancelAtPeriodEnd?: boolean;
}

export interface TelegramLoginResult {
  userId: number;
  token: string;
  isNew: boolean;
  provider: 'telegram';
  telegramId: string;
}

export interface ConfirmResult {
  clientToken: string;
  deviceId: string;
  desktopNotified?: boolean;
  e2eKeyReceived?: boolean;
  desktopPublicKeyHex?: string;
  e2eAvailable?: boolean;
}

export interface ClaimResult {
  success: boolean;
  deviceId: string;
  alreadyBound?: boolean;
}

export interface ApprovalResponseResult {
  success: boolean;
  eventId: string;
  decision: string;
}

export interface RedeemResult {
  success: boolean;
  product: string;
  plan: string;
  durationDays: number;
  afterExpiresAt: string;
}
