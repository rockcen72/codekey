import type postgres from 'postgres';

/**
 * Schedule periodic cleanup of expired sessions and events.
 * Only finished sessions are deleted — active/paused sessions are
 * never touched regardless of age.
 *
 * Configured via EVENT_RETENTION_DAYS env var:
 *   - unset / empty → 7 days
 *   - "0"           → no automatic cleanup
 *   - positive int  → custom retention window
 */
export function scheduleCleanup(sql: postgres.Sql): void {
  const raw = process.env.EVENT_RETENTION_DAYS;
  const days = raw === undefined || raw === '' ? 7 : Number(raw);
  if (!days || days <= 0 || !Number.isInteger(days)) {
    return;
  }

  const run = async () => {
    try {
      const result = await sql.begin(async (tx) => {
        // Delete events belonging to finished sessions past retention
        const deletedEvents = await tx`
          DELETE FROM events WHERE session_id IN (
            SELECT id FROM sessions
            WHERE status = 'finished'
              AND finished_at < now() - interval '1 day' * ${days}::int
          )
        `;
        // Delete finished sessions past retention
        const deletedSessions = await tx`
          DELETE FROM sessions
          WHERE status = 'finished'
            AND finished_at < now() - interval '1 day' * ${days}::int
        `;
        return { events: deletedEvents.count, sessions: deletedSessions.count };
      });
    } catch (err) {
      console.error('[cleanup] error:', err);
    }
  };

  // Run once on startup, then every hour
  void run();
  setInterval(run, 3600_000);
}
