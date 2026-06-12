import type postgres from 'postgres';

export function getRetentionDays(): number {
  const raw = process.env.EVENT_RETENTION_DAYS;
  const days = raw === undefined || raw === '' ? 7 : Number(raw);
  if (!days || days <= 0 || !Number.isInteger(days)) return 0;
  return days;
}

export async function runRetentionCleanup(sql: postgres.Sql): Promise<void> {
  const days = getRetentionDays();
  if (days <= 0) return;

  await sql`
    DELETE FROM events WHERE session_id IN (
      SELECT id FROM sessions
      WHERE status = 'finished'
        AND finished_at < now() - interval '1 day' * ${days}::int
    )
  `;
  await sql`
    DELETE FROM sessions
    WHERE status = 'finished'
      AND finished_at < now() - interval '1 day' * ${days}::int
  `;
}
