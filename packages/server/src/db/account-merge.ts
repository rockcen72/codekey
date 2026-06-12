import type postgres from 'postgres';

type DbLike = postgres.TransactionSql<{}>;

export async function mergeUserAccount(
  tx: DbLike,
  fromUserId: number,
  toUserId: number,
): Promise<void> {
  if (fromUserId === toUserId) return;

  const lockIds = [fromUserId, toUserId].sort((a, b) => a - b);
  await tx`
    SELECT id FROM users
    WHERE id = ANY(${tx.array(lockIds)}::bigint[])
    FOR UPDATE
  `;

  await tx`
    INSERT INTO user_subscriptions (user_id, product, plan, expires_at, source, updated_at)
    SELECT ${toUserId}, product, plan, expires_at, source, now()
    FROM user_subscriptions
    WHERE user_id = ${fromUserId}
    ON CONFLICT (user_id, product) DO UPDATE SET
      plan = CASE
        WHEN EXCLUDED.expires_at > user_subscriptions.expires_at THEN EXCLUDED.plan
        ELSE user_subscriptions.plan
      END,
      expires_at = GREATEST(user_subscriptions.expires_at, EXCLUDED.expires_at),
      source = CASE
        WHEN EXCLUDED.expires_at > user_subscriptions.expires_at THEN EXCLUDED.source
        ELSE user_subscriptions.source
      END,
      updated_at = now()
  `;
  await tx`DELETE FROM user_subscriptions WHERE user_id = ${fromUserId}`;

  await tx`
    INSERT INTO trial_claims (user_id, product, started_at, expires_at)
    SELECT ${toUserId}, product, started_at, expires_at
    FROM trial_claims
    WHERE user_id = ${fromUserId}
    ON CONFLICT (user_id, product) DO UPDATE SET
      started_at = LEAST(trial_claims.started_at, EXCLUDED.started_at),
      expires_at = GREATEST(trial_claims.expires_at, EXCLUDED.expires_at)
  `;
  await tx`DELETE FROM trial_claims WHERE user_id = ${fromUserId}`;

  await tx`
    INSERT INTO approval_usage (user_id, product, period, count)
    SELECT ${toUserId}, product, period, count
    FROM approval_usage
    WHERE user_id = ${fromUserId}
    ON CONFLICT (user_id, product, period) DO UPDATE SET
      count = approval_usage.count + EXCLUDED.count
  `;
  await tx`DELETE FROM approval_usage WHERE user_id = ${fromUserId}`;

  await tx`
    INSERT INTO approval_events_dedup (user_id, product, period, client_event_id, created_at)
    SELECT ${toUserId}, product, period, client_event_id, created_at
    FROM approval_events_dedup
    WHERE user_id = ${fromUserId}
    ON CONFLICT (user_id, product, period, client_event_id) DO NOTHING
  `;
  await tx`DELETE FROM approval_events_dedup WHERE user_id = ${fromUserId}`;

  await tx`UPDATE redeem_logs SET user_id = ${toUserId} WHERE user_id = ${fromUserId}`;
  await tx`UPDATE redeem_codes SET used_by = ${toUserId} WHERE used_by = ${fromUserId}`;
  await tx`UPDATE device_bindings SET user_id = ${toUserId} WHERE user_id = ${fromUserId}`;

  await tx`
    INSERT INTO auth_identities (user_id, provider, openid, unionid, created_at)
    SELECT ${toUserId}, provider, openid, unionid, created_at
    FROM auth_identities
    WHERE user_id = ${fromUserId}
    ON CONFLICT (provider, openid) DO UPDATE SET
      user_id = EXCLUDED.user_id,
      unionid = COALESCE(auth_identities.unionid, EXCLUDED.unionid)
  `;

  await tx`DELETE FROM users WHERE id = ${fromUserId}`;
}
