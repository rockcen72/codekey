import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { userRequest } from '../api/client';
import type { ApprovalResponseResult, UserEvent, UserSession } from '../api/types';
import type { AuthState } from '../hooks/useAuth';
import { DeviceBadge } from '../components/DeviceBadge';
import { formatDate } from '../utils/format';
import { markdownToHtml } from '../utils/markdown';

// ── Constants ───────────────────────────────────────

const POLL_INTERVAL = 10_000;

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
  high: ['deny', 'pause', 'reply'],
  critical: ['deny', 'pause'],
  unknown: ['deny', 'pause', 'reply'],
};

const DECISION_LABEL: Record<string, string> = {
  approve: 'Approve',
  deny: 'Deny',
  pause: 'Pause',
  reply: 'Reply',
};

// ── Toast (lightweight) ─────────────────────────────

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

// ── EventRow ────────────────────────────────────────

function EventRow({ event, resolvedDecision, onDecision }: {
  event: UserEvent;
  resolvedDecision?: string;
  onDecision: (eventId: string, decision: string, message?: string) => Promise<void>;
}) {
  const data = (event.data ?? {}) as Record<string, unknown>;
  const summary = (data.summary as string) || (data.command as string) || '';
  const command = (data.command as string) || '';
  const risk = event.risk_level || (data.risk as string) || null;
  const isInteractive = event.type === 'approval_required' || event.type === 'input_required';
  const [replyText, setReplyText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);

  const allowed = risk ? (ALLOWED_DECISIONS[risk] ?? ['deny', 'pause']) : ['deny', 'pause'];
  const isHighRisk = risk === 'high' || risk === 'critical';

  const effectiveDecision = resolvedDecision ?? event.decision;
  const effectivePending = event.pending && !resolvedDecision;

  async function handleDecision(decision: string) {
    setBusy(decision);
    try {
      await onDecision(event.id, decision, decision === 'reply' ? replyText : undefined);
    } finally {
      setBusy(null);
    }
  }

  // session_idle: centered system marker
  if (event.type === 'session_idle') {
    return (
      <div className="event-system">
        <span className="event-system-text">Agent is idle, waiting for instructions...</span>
        <span className="event-system-time">{formatDate(event.created_at)}</span>
      </div>
    );
  }

  // command_started: AI card with RUNNING badge
  if (event.type === 'command_started') {
    return (
      <article className="event-row">
        <div className="event-header">
          <span className="event-type event-type-command_started">Command</span>
          <span className="kind-badge kind-badge-running">RUNNING</span>
        </div>
        <div className="event-summary">Received by desktop, handing off to Agent...</div>
        {command ? <div className="event-command"><code>{command}</code></div> : null}
        <div className="event-footer">
          <span className="event-time">{formatDate(event.created_at)}</span>
        </div>
      </article>
    );
  }

  return (
    <article className={`event-row${effectivePending ? ' event-pending' : ''}`}>
      <div className="event-header">
        {event.type === 'approval_required' ? <span className="event-type event-type-approval_required">Approval</span> : null}
        {event.type === 'input_required' ? <span className="event-type event-type-input_required">Input</span> : null}
        {event.type === 'user_prompt' ? <span className="event-type event-type-user_prompt">Prompt</span> : null}
        {event.type === 'task_complete' ? <span className="event-type event-type-task_complete">Task Complete</span> : null}
        {event.type === 'error' ? <span className="event-type event-type-error">Error</span> : null}
        {event.type === 'task_complete' ? <span className="kind-badge kind-badge-done">DONE</span> : null}
        {event.type === 'input_required' && effectivePending ? <span className="kind-badge kind-badge-input">INPUT</span> : null}
        {risk ? <span className={`risk-badge risk-${risk}`}>{risk}</span> : null}
        {effectivePending ? <span className="pending-badge">Pending</span> : null}
      </div>
      {summary && event.type === 'task_complete' ? <div className="event-summary event-summary-html" dangerouslySetInnerHTML={{ __html: markdownToHtml(summary) }} /> : null}
      {summary && event.type !== 'task_complete' ? <div className="event-summary">{summary}</div> : null}
      {command && command !== summary ? <div className="event-command"><code>{command}</code></div> : null}
      <div className="event-footer">
        <span className="event-time">{formatDate(event.created_at)}</span>
        {!effectivePending && effectiveDecision ? (
          <span className={`decision-badge decision-${effectiveDecision}`}>{DECISION_LABEL[effectiveDecision] || effectiveDecision}</span>
        ) : null}
        {!effectivePending && !effectiveDecision ? <span className="muted">Recorded</span> : null}
      </div>

      {/* Approval actions */}
      {isInteractive && effectivePending ? (
        <div className="approval-actions">
          {isHighRisk ? (
            <div className="high-risk-notice">High risk — please confirm on desktop</div>
          ) : null}
          {event.type === 'input_required' ? (
            <div className="reply-row">
              <input
                className="reply-input"
                type="text"
                value={replyText}
                onChange={(e) => setReplyText(e.target.value)}
                placeholder="Type your reply..."
              />
              <button
                className="primary-button btn-sm"
                type="button"
                disabled={!replyText.trim() || busy !== null}
                onClick={() => void handleDecision('reply')}
              >
                {busy === 'reply' ? 'Sending...' : 'Reply'}
              </button>
            </div>
          ) : null}
          <div className="decision-buttons">
            {allowed
              .filter((d) => !(event.type === 'input_required' && d === 'reply'))
              .filter((d) => !(isHighRisk && d === 'approve'))
              .map((d) => (
                <button
                  key={d}
                  className={`ghost-button btn-sm decision-btn decision-btn-${d}`}
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void handleDecision(d)}
                >
                  {busy === d ? '...' : DECISION_LABEL[d] || d}
                </button>
              ))}
          </div>
        </div>
      ) : null}
    </article>
  );
}

// ── SessionDetailPage ───────────────────────────────

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
  const loadingRef = useRef(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const userScrolledRef = useRef(false);

  const load = useCallback(async () => {
    if (!auth.token || !id || loadingRef.current) return;
    loadingRef.current = true;
    try {
      const [nextSession, nextEvents] = await Promise.all([
        userRequest<UserSession>(`/api/v1/user/sessions/${id}`),
        userRequest<UserEvent[]>(`/api/v1/user/sessions/${id}/events`),
      ]);

      // Sort by created_at ascending (oldest first, newest last)
      nextEvents.sort((a, b) => {
        const ta = new Date(a.created_at).getTime();
        const tb = new Date(b.created_at).getTime();
        return ta - tb;
      });

      // Stale pending detection
      setEvents(prev => {
        const prevPending = prev.filter(e => e.pending);
        const nextMap = new Map(nextEvents.map(e => [e.id, e]));
        for (const old of prevPending) {
          const fresh = nextMap.get(old.id);
          if (fresh && !fresh.pending && !fresh.decision) {
            setResolvedMap(prev => {
              if (prev.has(old.id)) return prev;
              const next = new Map(prev);
              next.set(old.id, 'resolved');
              return next;
            });
          }
        }
        return nextEvents;
      });

      // Clean resolvedMap for events confirmed by server
      setResolvedMap(prev => {
        const next = new Map(prev);
        for (const [eid] of next) {
          const fresh = nextEvents.find(e => e.id === eid);
          if (fresh && !fresh.pending) next.delete(eid);
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

  // Auto-scroll to bottom after load (unless user scrolled up)
  // Also scroll if there are new pending events
  useEffect(() => {
    const hasPending = events.some(e => e.pending);
    if ((!userScrolledRef.current || hasPending) && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [events]);

  // Initial fetch
  useEffect(() => {
    void load();
  }, [load]);

  // 10s polling + visibilitychange
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
      else { void load(); startPoll(); }
    }

    startPoll();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopPoll();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [auth.token, id, load]);

  // Track user scroll position
  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    userScrolledRef.current = !nearBottom;
  }

  // Approval handler with optimistic UI + toast errors
  const handleDecision = useCallback(async (eventId: string, decision: string, message?: string) => {
    setResolvedMap(prev => new Map(prev).set(eventId, decision));

    try {
      await userRequest<ApprovalResponseResult>(`/api/v1/events/${eventId}/approval-response`, {
        method: 'POST',
        body: JSON.stringify({ decision, message }),
      });
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Approval failed';
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

  // Filter: only allowed event types, skip agent context duplicates
  const filteredEvents = events.filter(e => {
    if (!ALLOWED_EVENT_TYPES.has(e.type)) return false;
    if (e.type === 'user_prompt') {
      const data = (e.data ?? {}) as Record<string, unknown>;
      if (data.agentType || data.eventAgentType) return false;
    }
    return true;
  });

  // Prompt input
  const [promptText, setPromptText] = useState('');
  const [promptBusy, setPromptBusy] = useState(false);
  const isActive = session?.status === 'active';

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
      await load();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to send';
      showToast(msg);
    } finally {
      setPromptBusy(false);
    }
  }

  return (
    <main className="shell">
      <header className="page-header">
        <button className="ghost-button" type="button" onClick={() => navigate('/')}>Back</button>
        <h1>{session?.metadata.title || 'Session Detail'}</h1>
        <button className="ghost-button" type="button" onClick={() => void load()}>Refresh</button>
      </header>
      {error ? <div className="notice error-text">{error}</div> : null}
      {filteredEvents.some(e => e.pending) ? (
        <div className="pending-alert">There are pending approval requests below</div>
      ) : null}
      {session ? (
        <section className="detail-panel">
          <div className="session-meta">
            <DeviceBadge name={session.device_name} deviceId={session.device_id} />
            <span>{formatDate(session.last_active_at)}</span>
          </div>
        </section>
      ) : null}
      <section className="event-list event-list-scroll" ref={scrollRef} onScroll={handleScroll}>
        {filteredEvents.length === 0 ? <div className="notice">No events recorded</div> : null}
        {filteredEvents.map((event) => (
          <EventRow
            key={event.id}
            event={event}
            resolvedDecision={resolvedMap.get(event.id)}
            onDecision={handleDecision}
          />
        ))}
      </section>
      {isActive ? (
        <section className="prompt-bar">
          <input
            className="prompt-input"
            type="text"
            value={promptText}
            onChange={(e) => setPromptText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void sendPrompt(); } }}
            placeholder="Send a command to desktop..."
            disabled={promptBusy}
          />
          <button
            className="primary-button btn-sm"
            type="button"
            disabled={!promptText.trim() || promptBusy}
            onClick={() => void sendPrompt()}
          >
            {promptBusy ? '...' : 'Send'}
          </button>
        </section>
      ) : null}
    </main>
  );
}
