import { createHash } from 'node:crypto';

export function stableHistoryEventId(localSessionId: string, role: string | undefined, text: string | undefined, createdAt?: number | string): string {
  const seed = `${role ?? ''}|${text ?? ''}|${createdAt ?? ''}`;
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 12);
  return `oc-hist:${localSessionId}:${hash}`;
}
