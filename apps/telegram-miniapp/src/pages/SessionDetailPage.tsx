import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { userRequest } from '../api/client';
import type { ApprovalResponseResult, UserEvent, UserSession } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { compactMarkdownWhitespace, markdownToHtml } from '../utils/markdown';
import { agentChatName, agentColorClass, agentLabel } from '../utils/session-display';
import { decryptEventPayload } from '../utils/encryption';
import { getContentKey, getDeviceId } from '../auth/device-storage';

const POLL_INTERVAL = 5_000;

const ALLOWED_EVENT_TYPES = new Set([
  'user_prompt',
  'command_started',
  'task_complete',
  'approval_required',
  'input_required',
  'error',
  'session_idle',
]);

const ALLOWED_DECISIONS: Record<string, string[]> = {
  low: ['approve', 'deny', 'pause', 'reply'],
  medium: ['approve', 'deny', 'pause', 'reply'],
  high: ['approve', 'deny', 'pause', 'reply'],
  critical: ['approve', 'deny', 'pause'],
  unknown: ['approve', 'deny', 'pause', 'reply'],
};

const DECISION_LABEL: Record<string, string> = {
  approve: 'Approved',
  deny: 'Denied',
  pause: 'Paused',
  reply: 'Replied',
  resolved: 'Resolved',
};

const RISK_LABEL: Record<string, string> = {
  low: 'Low Risk',
  medium: 'Medium Risk',
  high: 'High Risk',
  critical: 'Critical Risk',
  unknown: 'Unknown Risk',
};

const EVENT_LABEL: Record<string, string> = {
  approval_required: 'Approval',
  input_required: 'Input Required',
  task_complete: 'Task Complete',
  command_started: 'Command',
  error: 'Error',
};

interface InputOption {
  label: string;
  value: string;
  description?: string;
}

interface ChatMessage {
  id: string;
  eventId: string;
  type: 'agent' | 'user' | 'system';
  eventType: string;
  senderName: string;
  content: string;
  contentHtml?: string;
  command: string;
  typeLabel: string;
  kindBadge: string;
  risk: string | null;
  pending: boolean;
  decision: string | null;
  createdAt: string;
  accent: 'pending' | 'approved' | 'denied' | 'complete' | 'neutral';
  agentClass: 'claude' | 'codex' | 'opencode' | 'unknown';
  inputOptions: InputOption[];
}

interface MessageRowProps {
  message: ChatMessage;
  resolvedDecision?: string;
  onDecision: (eventId: string, decision: string, message?: string) => Promise<void>;
}

interface DockProps {
  message: ChatMessage;
  onDecision: (eventId: string, decision: string, message?: string) => Promise<void>;
}

function showToast(msg: string) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('toast-visible'));
  setTimeout(() => {
    el.classList.remove('toast-visible');
    setTimeout(() => el.remove(), 300);
  }, 2000);
}

function formatTime(value?: string | null): string {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

function getEventData(event: UserEvent): Record<string, unknown> {
  return (event.data ?? {}) as Record<string, unknown>;
}

/** Module-level cache for decrypted event bodies, keyed by event id.
 *  Decryption is deterministic + idempotent, so caching across re-polls is
 *  safe and avoids re-running Web Crypto on every 5s tick. */
const decryptedEventCache = new Map<string, Record<string, unknown>>();
const decryptionFailureLogged = new Set<string>();

/** Decrypt all encrypted events in-place (mutates the event.data field).
 *
 *  Behavior matrix (mirrors PC plan §5.3):
 *    - sealed_payload missing                  → leave event untouched (legacy plaintext)
 *    - data.encryption_error === true          → leave event as-is (PC failed encryption, show placeholder)
 *    - encryption_version unknown              → leave + log once (treat as undecryptable placeholder)
 *    - no contentKey / no deviceId stored      → leave + log once (user not paired with E2E)
 *    - decrypt throws                          → leave + log once
 *    - decrypt succeeds                        → merge decrypted body into event.data
 */
async function decryptEvents(events: UserEvent[]): Promise<UserEvent[]> {
  const contentKey = getContentKey();
  const deviceId = getDeviceId();
  if (!contentKey || !deviceId) return events;

  const tasks: Promise<void>[] = [];
  const out = events.map((event) => ({ ...event }));

  for (const event of out) {
    if (!event.sealed_payload || !event.key_id) continue;
    if (event.encryption_version !== 1) {
      if (!decryptionFailureLogged.has(event.id)) {
        console.warn('[session-detail] unknown encryption_version', event.encryption_version, 'for event', event.id);
        decryptionFailureLogged.add(event.id);
      }
      continue;
    }
    const data = (event.data ?? {}) as Record<string, unknown>;
    if (data.encryption_error === true) continue; // PC fail-closed placeholder — render as-is

    const cached = decryptedEventCache.get(event.id);
    if (cached) {
      event.data = cached;
      continue;
    }

    const sealed = event.sealed_payload;
    const allowlist = data;
    const aadFields = {
      v: 1,
      keyId: event.key_id,
      deviceId,
      sessionId: event.session_id,
      eventId: (data.clientEventId as string) || event.id, // Phase 4 AAD = clientEventId; fall back to server id only for legacy events
      eventType: event.type,
    };

    tasks.push(
      decryptEventPayload(sealed, allowlist, contentKey, aadFields)
        .then((merged) => {
          decryptedEventCache.set(event.id, merged);
          event.data = merged;
        })
        .catch((err) => {
          if (!decryptionFailureLogged.has(event.id)) {
            console.error('[session-detail] decrypt failed for event', event.id, err);
            decryptionFailureLogged.add(event.id);
          }
          // Leave event.data as-is (allowlist only) — UI will show preview_label
        }),
    );
  }

  if (tasks.length > 0) await Promise.all(tasks);
  return out;
}

function getEncryptedPlaceholder(data: Record<string, unknown>): string | null {
  // PC fail-closed event — actual prompt couldn't be encrypted
  if (data.encryption_error === true) return 'Encrypted content unavailable (encryption failed on desktop)';
  // Phone-side: still encrypted because key missing or decrypt blew up
  if (data.encrypted === true) return 'Encrypted content unavailable';
  return null;
}

function isUserPromptEvent(event: UserEvent, data: Record<string, unknown>): boolean {
  return event.type === 'user_prompt'
    || data.type === 'user_prompt'
    || data.role === 'user'
    || event.role === 'user';
}

function extractInputOptions(data: Record<string, unknown>): InputOption[] {
  const questions = Array.isArray(data.questions) ? data.questions as Record<string, unknown>[] : [];
  const first = questions.find((question) => Array.isArray(question.options));
  const options = first?.options;
  if (!Array.isArray(options)) return [];

  return options
    .map((option): InputOption | null => {
      if (typeof option === 'string') return { label: option, value: option };
      if (!option || typeof option !== 'object') return null;
      const raw = option as Record<string, unknown>;
      const label = String(raw.label || raw.value || raw.name || '');
      const value = String(raw.value || raw.id || raw.label || '');
      if (!label || !value) return null;
      return {
        label,
        value,
        description: raw.description ? String(raw.description) : undefined,
      };
    })
    .filter((option): option is InputOption => option !== null);
}

function decisionLabel(decision?: string | null): string {
  if (!decision) return '';
  return DECISION_LABEL[decision] || decision;
}

function buildChatMessages(events: UserEvent[], session: UserSession | null, resolvedMap: Map<string, string>): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let lastUserPrompt = '';
  let lastCommandStarted = false;
  let pendingCommandStarted: ChatMessage | null = null;
  const flushPendingCommandStarted = () => {
    if (!pendingCommandStarted) return;
    messages.push(pendingCommandStarted);
    pendingCommandStarted = null;
  };

  for (const event of events) {
    if (!ALLOWED_EVENT_TYPES.has(event.type)) continue;

    const data = getEventData(event);
    const eventAgentType = String(data.agent || data.agentType || session?.agent_type || session?.metadata.runtime || '');
    const agentClass = agentColorClass(eventAgentType);
    const risk = event.risk_level || (data.risk ? String(data.risk) : null);
    const command = String(data.command || '');
    const rawSummary = String(data.summary || data.prompt || data.message || data.command || '');
    const summary = event.type === 'task_complete' ? compactMarkdownWhitespace(rawSummary) : rawSummary;
    const resolvedDecision = resolvedMap.get(event.id);
    const effectivePending = event.pending && !resolvedDecision;
    const effectiveDecision = resolvedDecision || event.decision;
    const isUserPrompt = isUserPromptEvent(event, data);

    if (event.type === 'session_idle') {
      flushPendingCommandStarted();
      lastCommandStarted = false;
      messages.push({
        id: event.id,
        eventId: event.id,
        type: 'system',
        eventType: event.type,
        senderName: '',
        content: 'Agent is idle, waiting for instructions...',
        command: '',
        typeLabel: '',
        kindBadge: '',
        risk: null,
        pending: false,
        decision: null,
        createdAt: event.created_at,
        accent: 'neutral',
        agentClass,
        inputOptions: [],
      });
      continue;
    }

    if (isUserPrompt) {
      lastCommandStarted = false;
      // Plan §5.3: when sealed_payload couldn't be decrypted, data only has
      // allowlist fields (encrypted=true / encryption_error=true). Render a
      // placeholder string instead of empty to keep the bubble visible.
      const placeholder = getEncryptedPlaceholder(data);
      const prompt = placeholder
        ?? String(data.prompt || data.summary || rawSummary || '');
      if (!prompt || prompt === lastUserPrompt) continue;
      lastUserPrompt = prompt;
      messages.push({
        id: event.id,
        eventId: event.id,
        type: 'user',
        eventType: 'user_prompt',
        senderName: 'You',
        content: prompt,
        command: '',
        typeLabel: '',
        kindBadge: '',
        risk: null,
        pending: false,
        decision: null,
        createdAt: event.created_at,
        accent: 'neutral',
        agentClass: 'unknown',
        inputOptions: [],
      });
      flushPendingCommandStarted();
      continue;
    }

    const inputOptions = event.type === 'input_required' ? extractInputOptions(data) : [];
    if (event.type === 'command_started') {
      if (lastCommandStarted) continue;
      lastCommandStarted = true;
    } else {
      flushPendingCommandStarted();
      lastCommandStarted = false;
    }
    const accent = effectivePending
      ? 'pending'
      : effectiveDecision === 'approve'
        ? 'approved'
        : effectiveDecision === 'deny'
          ? 'denied'
          : event.type === 'task_complete'
            ? 'complete'
            : 'neutral';

    const message: ChatMessage = {
      id: event.id,
      eventId: event.id,
      type: 'agent',
      eventType: event.type,
      senderName: agentChatName(eventAgentType),
      content: event.type === 'command_started' ? 'Agent is processing...' : summary,
      contentHtml: event.type === 'task_complete' && summary ? markdownToHtml(summary) : undefined,
      command,
      typeLabel: event.type === 'command_started' ? '' : EVENT_LABEL[event.type] || event.type,
      kindBadge: effectivePending
        ? event.type === 'input_required'
          ? 'INPUT'
          : 'PENDING'
        : event.type === 'command_started'
          ? ''
        : event.type === 'task_complete'
          ? 'DONE'
          : decisionLabel(effectiveDecision) || 'DONE',
      risk,
      pending: effectivePending,
      decision: effectiveDecision || null,
      createdAt: event.created_at,
      accent,
      agentClass,
      inputOptions,
    };

    if (event.type === 'command_started') {
      if (messages[messages.length - 1]?.eventType === 'user_prompt') {
        messages.push(message);
      } else {
        pendingCommandStarted = message;
      }
      continue;
    }

    messages.push(message);

    if (!effectivePending && effectiveDecision && ['approve', 'deny', 'pause', 'reply'].includes(effectiveDecision)) {
      messages.push({
        id: `${event.id}-decision`,
        eventId: event.id,
        type: 'user',
        eventType: 'decision',
        senderName: 'You',
        content: decisionLabel(effectiveDecision),
        command: '',
        typeLabel: '',
        kindBadge: '',
        risk: null,
        pending: false,
        decision: effectiveDecision,
        createdAt: event.created_at,
        accent: 'neutral',
        agentClass: 'unknown',
        inputOptions: [],
      });
    }
  }

  flushPendingCommandStarted();
  return messages;
}

function MessageRow({ message, resolvedDecision, onDecision }: MessageRowProps) {
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const effectiveDecision = resolvedDecision || message.decision;
  const allowed = message.risk ? (ALLOWED_DECISIONS[message.risk] ?? ['deny', 'pause']) : ['approve', 'deny', 'pause', 'reply'];

  async function handleDecision(decision: string, text?: string) {
    setBusy(decision);
    try {
      await onDecision(message.eventId, decision, text);
      if (decision === 'reply') setReplyText('');
    } finally {
      setBusy(null);
    }
  }

  if (message.type === 'system') {
    return (
      <div className="timeline-marker">
        <span>{message.content}</span>
        <span>{formatTime(message.createdAt)}</span>
      </div>
    );
  }

  if (message.type === 'user') {
    return (
      <div className="msg-row right">
        <div className="chat-stack user-stack">
          <span className="sender-name">{message.senderName}</span>
          <div className="msg-bubble user">
            <span className="msg-text">{message.content}</span>
            <span className="msg-time">{formatTime(message.createdAt)}</span>
          </div>
        </div>
      </div>
    );
  }

  if (message.eventType === 'command_started') {
    return (
      <div className="msg-row left">
        <div className="chat-stack agent-stack">
          <span className="sender-name">{message.senderName}</span>
          <div className={`msg-bubble agent agent-${message.agentClass}`}>
            <span className="msg-text">{message.content}</span>
            <span className="msg-time">{formatTime(message.createdAt)}</span>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="msg-row left">
      <div className="chat-stack agent-stack">
        <span className="sender-name">{message.senderName}</span>
        <article className={`timeline-card accent-${message.accent} agent-${message.agentClass}`}>
          <div className="timeline-card-head">
            <div className="timeline-card-head-left">
              <span className={`event-glyph glyph-${message.accent}`} />
              {message.typeLabel ? <span className="event-type">{message.typeLabel}</span> : null}
              {message.risk ? <span className={`risk-tag ${message.risk}`}>{RISK_LABEL[message.risk] || message.risk}</span> : null}
            </div>
            {message.kindBadge ? <span className={`kind-badge kind-${message.accent}`}>{message.kindBadge}</span> : null}
          </div>

          {message.command ? (
            <div className="cmd-line">
              <code>{message.command}</code>
            </div>
          ) : null}

          {message.contentHtml ? (
            <div className="event-summary event-summary-html" dangerouslySetInnerHTML={{ __html: message.contentHtml }} />
          ) : message.content ? (
            <div className="event-summary">{message.content}</div>
          ) : null}

          {message.pending && message.inputOptions.length > 0 ? (
            <div className="input-options">
              {message.inputOptions.map((option) => (
                <button
                  key={option.value}
                  className="input-option"
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleDecision('reply', option.value)}
                >
                  <span className="input-option-label">{option.label}</span>
                  {option.description ? <span className="input-option-desc">{option.description}</span> : null}
                </button>
              ))}
            </div>
          ) : null}

          <div className="event-foot">
            <div className="foot-tags">
              {message.pending ? (
                <span className="pending-pulse">
                  <span className="pulse-dot" />
                  Pending
                </span>
              ) : effectiveDecision ? (
                <span className={`decision-tag ${effectiveDecision}`}>{decisionLabel(effectiveDecision)}</span>
              ) : null}
            </div>
            <span className="event-time">{formatTime(message.createdAt)}</span>
          </div>

          {message.pending ? (
            <div className="inline-actions">
              {allowed.includes('reply') ? (
                <div className="reply-row">
                  <input
                    className="reply-input"
                    type="text"
                    value={replyText}
                    onChange={(event) => setReplyText(event.target.value)}
                    placeholder={message.eventType === 'input_required' ? 'Type option or instruction...' : 'Reply to Agent...'}
                    disabled={busy !== null}
                  />
                  <button
                    className="primary-button btn-sm"
                    type="button"
                    disabled={!replyText.trim() || busy !== null}
                    onClick={() => void handleDecision('reply', replyText.trim())}
                  >
                    {busy === 'reply' ? '...' : 'Send'}
                  </button>
                </div>
              ) : null}
              <div className="decision-buttons">
                {allowed.filter((decision) => decision !== 'reply').map((decision) => (
                  <button
                    key={decision}
                    className={`ghost-button btn-sm decision-btn decision-btn-${decision}`}
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void handleDecision(decision)}
                  >
                    {busy === decision ? '...' : decisionLabel(decision)}
                  </button>
                ))}
              </div>
            </div>
          ) : null}
        </article>
      </div>
    </div>
  );
}

function ApprovalDock({ message, onDecision }: DockProps) {
  const [expanded, setExpanded] = useState(true);
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const allowed = message.risk ? (ALLOWED_DECISIONS[message.risk] ?? ['deny', 'pause']) : ['approve', 'deny', 'pause', 'reply'];

  async function send(decision: string, text?: string) {
    setBusy(decision);
    try {
      await onDecision(message.eventId, decision, text);
      if (decision === 'reply') setReplyText('');
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className={`approval-dock ${expanded ? 'expanded' : ''}`}>
      <div className={`dock-card agent-${message.agentClass}`}>
        <button className="dock-bar" type="button" onClick={() => setExpanded((value) => !value)}>
          <span className="dock-bar-left">
            <span className="dock-pulse" />
            <span className="dock-kicker">{message.eventType === 'input_required' ? 'Selection needed' : 'Awaiting approval'}</span>
            <span className="dock-title">{message.content || message.command || message.typeLabel}</span>
          </span>
          <span className="dock-bar-right">
            {message.risk ? <span className={`risk-tag ${message.risk}`}>{RISK_LABEL[message.risk] || message.risk}</span> : null}
            <span className="dock-chevron">{expanded ? '▼' : '▲'}</span>
          </span>
        </button>

        {expanded ? (
          <div className="dock-body">
            {message.command ? (
              <div className="dock-command">
                <code>{message.command}</code>
              </div>
            ) : null}
            {message.inputOptions.length > 0 ? (
              <div className="dock-options">
                {message.inputOptions.map((option) => (
                  <button
                    key={option.value}
                    className="dock-option-btn"
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void send('reply', option.value)}
                  >
                    <span className="dock-option-label">{option.label}</span>
                    {option.description ? <span className="dock-option-desc">{option.description}</span> : null}
                  </button>
                ))}
              </div>
            ) : null}
            {allowed.includes('reply') ? (
              <div className="dock-reply">
                <input
                  className="dock-reply-input"
                  value={replyText}
                  onChange={(event) => setReplyText(event.target.value)}
                  placeholder={message.eventType === 'input_required' ? 'Type option or instruction...' : 'Reply to Agent...'}
                  disabled={busy !== null}
                />
                <button
                  className={`dock-reply-send ${replyText.trim() ? 'active' : ''}`}
                  type="button"
                  disabled={!replyText.trim() || busy !== null}
                  onClick={() => void send('reply', replyText.trim())}
                >
                  Send
                </button>
              </div>
            ) : null}
            <div className="dock-actions">
              {allowed.filter((decision) => decision !== 'reply').map((decision) => (
                <button
                  key={decision}
                  className={`dock-btn ${decision === 'approve' ? 'primary' : decision === 'deny' ? 'danger' : 'ghost'}`}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void send(decision)}
                >
                  {busy === decision ? '...' : decisionLabel(decision)}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface Props {
  auth: AuthState;
}

export function SessionDetailPage({ auth }: Props) {
  const { id } = useParams();
  const navigate = useNavigate();
  const [session, setSession] = useState<UserSession | null>(null);
  const [events, setEvents] = useState<UserEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [resolvedMap, setResolvedMap] = useState<Map<string, string>>(new Map());
  const [promptText, setPromptText] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const loadingRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const load = useCallback(async () => {
    if (!auth.token || !id || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [nextSession, rawEvents] = await Promise.all([
        userRequest<UserSession>(`/api/v1/user/sessions/${id}`),
        userRequest<UserEvent[]>(`/api/v1/user/sessions/${id}/events`),
      ]);

      // Decrypt encrypted events before sorting/dedup so downstream logic sees
      // the merged plaintext data. Plan §5.3 / §5.4 — sealed_payload events
      // get their data field populated with decrypted body; legacy plaintext
      // events pass through untouched.
      const nextEvents = await decryptEvents(rawEvents);

      nextEvents.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());

      setEvents((prev) => {
        const nextMap = new Map(nextEvents.map((event) => [event.id, event]));
        for (const old of prev.filter((event) => event.pending)) {
          const fresh = nextMap.get(old.id);
          if (fresh && !fresh.pending && !fresh.decision) {
            setResolvedMap((current) => {
              if (current.has(old.id)) return current;
              const next = new Map(current);
              next.set(old.id, 'resolved');
              return next;
            });
          }
        }
        return nextEvents;
      });

      setResolvedMap((current) => {
        const next = new Map(current);
        for (const [eventId] of next) {
          const fresh = nextEvents.find((event) => event.id === eventId);
          if (fresh && !fresh.pending) next.delete(eventId);
        }
        return next;
      });

      setSession(nextSession);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load session');
    } finally {
      loadingRef.current = false;
    }
  }, [auth.token, id]);

  const messages = useMemo(() => buildChatMessages(events, session, resolvedMap), [events, session, resolvedMap]);
  const primaryPending = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].type === 'agent' && messages[i].pending) return messages[i];
    }
    return null;
  }, [messages]);
  const isActive = session?.status === 'active';
  const title = session?.metadata.title || agentLabel(session?.agent_type) || 'AI Agent';
  const detailAgentClass = agentColorClass(session?.agent_type || session?.metadata.runtime);
  const [searchParams] = useSearchParams();
  const targetEventId = searchParams.get('eventId');

  useEffect(() => {
    const hasPending = messages.some((message) => message.pending);
    if ((!userScrolledRef.current || hasPending) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Scroll to target event from deep link
  useEffect(() => {
    if (!targetEventId || !scrollRef.current || !messages.length) return;
    const idx = messages.findIndex((m) => m.eventId === targetEventId);
    if (idx === -1) return;
    const el = scrollRef.current.children[idx] as HTMLElement | undefined;
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.style.outline = '2px solid var(--accent)';
      setTimeout(() => { el.style.outline = ''; }, 3000);
    }
  }, [targetEventId, messages]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!auth.token || !id) return;

    function startPoll() {
      if (pollRef.current) return;
      pollRef.current = setInterval(() => void load(), POLL_INTERVAL);
    }
    function stopPoll() {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    function onVisibility() {
      if (document.hidden) stopPoll();
      else {
        void load();
        startPoll();
      }
    }

    startPoll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [auth.token, id, load]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledRef.current = !nearBottom;
  }

  const handleDecision = useCallback(async (eventId: string, decision: string, message?: string) => {
    setResolvedMap((current) => new Map(current).set(eventId, decision));

    try {
      await userRequest<ApprovalResponseResult>(`/api/v1/events/${eventId}/approval-response`, {
        method: 'POST',
        body: JSON.stringify({ decision, message }),
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Operation failed';
      if (msg.includes('ALREADY_RESPONDED') || msg.includes('BRIDGE_NOT_CONNECTED') || msg.includes('RISK_TOO_HIGH')) {
        const label = msg.includes('ALREADY_RESPONDED') ? 'Already responded'
          : msg.includes('BRIDGE_NOT_CONNECTED') ? 'Desktop not connected'
          : 'Risk too high to approve';
        showToast(label);
        await load();
      } else {
        setError(msg);
      }
    }
  }, [load]);

  async function sendPrompt() {
    if (!promptText.trim() || !id) return;
    setPromptBusy(true);
    try {
      await userRequest(`/api/v1/user/sessions/${id}/command`, {
        method: 'POST',
        body: JSON.stringify({ text: promptText.trim() }),
      });
      setPromptText('');
      showToast('Sent to desktop');
      userScrolledRef.current = false;
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Send failed';
      showToast(msg);
    } finally {
      setPromptBusy(false);
    }
  }

  return (
    <main className={`detail-shell agent-${detailAgentClass}`}>
      <header className="detail-topbar">
        <button className="back-btn" type="button" onClick={() => navigate('/')} aria-label="Back">
          ‹
        </button>
        <div className="title-wrap">
          <h1 className="detail-title">{title}</h1>
          <span className="detail-subtitle">{session?.metadata.cwd || session?.metadata.runtime || session?.agent_type || ''}</span>
        </div>
        <button className="ws-indicator online" type="button" onClick={() => void load()} aria-label="Refresh">
          <span className="ws-dot" />
        </button>
      </header>

      {error ? <div className="notice error-text detail-notice">{error}</div> : null}

      <section className="timeline" ref={scrollRef} onScroll={handleScroll}>
        {messages.length === 0 ? (
          <div className="empty">
            <span className="empty-icon">◌</span>
            <h2 className="empty-title">No messages yet</h2>
            <p className="empty-text">Messages will appear here when the Agent requests approval, completes tasks, or waits for instructions.</p>
          </div>
        ) : null}
        {messages.map((message) => (
          <MessageRow
            key={message.id}
            message={message}
            resolvedDecision={resolvedMap.get(message.eventId)}
            onDecision={handleDecision}
          />
        ))}
      </section>

      {primaryPending ? <ApprovalDock message={primaryPending} onDecision={handleDecision} /> : null}

      {isActive ? (
        <section className="composer">
          <div className="composer-inner">
            <div className="composer-input-wrap">
              <input
                className="composer-input"
                type="text"
                value={promptText}
                onChange={(event) => setPromptText(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault();
                    void sendPrompt();
                  }
                }}
                placeholder="Send command to Agent..."
                disabled={promptBusy}
              />
            </div>
            <button
              className={`composer-send ${promptText.trim() ? 'active' : ''}`}
              type="button"
              disabled={!promptText.trim() || promptBusy}
              onClick={() => void sendPrompt()}
              aria-label="Send"
            >
              ↑
            </button>
          </div>
        </section>
      ) : null}
    </main>
  );
}
