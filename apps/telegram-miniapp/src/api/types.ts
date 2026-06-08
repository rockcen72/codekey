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
  data: unknown;
  risk_level: string | null;
  pending: boolean;
  decision: string | null;
  created_at: string;
}

export interface SubscriptionStatus {
  tier: 'free' | 'trial' | 'pro';
  plan: string | null;
  expiresAt: string | null;
  product: string;
  usage: { used: number; limit: number } | null;
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
