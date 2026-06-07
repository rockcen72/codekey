import postgres from 'postgres';

export async function initDb(url: string) {
  const sql = postgres(url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
  });

  // Run migrations
  await sql`
    CREATE TABLE IF NOT EXISTS devices (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_name TEXT NOT NULL,
      device_secret TEXT,
      public_key TEXT,
      code TEXT UNIQUE,
      code_expires_at TIMESTAMPTZ,
      bound_to TEXT,
      last_seen_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID REFERENCES devices(id),
      agent_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      cwd TEXT,
      project_name TEXT,
      metadata JSONB DEFAULT '{}',
      started_at TIMESTAMPTZ DEFAULT now(),
      finished_at TIMESTAMPTZ,
      last_active_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      data JSONB NOT NULL DEFAULT '{}',
      risk_level TEXT,
      responder TEXT,
      decision TEXT,
      responded_at TIMESTAMPTZ,
      pending BOOLEAN DEFAULT true,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID REFERENCES events(id) UNIQUE,
      session_id UUID REFERENCES sessions(id),
      decision TEXT NOT NULL,
      responder TEXT,
      command TEXT,
      risk_level TEXT,
      message TEXT,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS connections (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID REFERENCES devices(id),
      peer_type TEXT NOT NULL,
      connected BOOLEAN DEFAULT true,
      connected_at TIMESTAMPTZ DEFAULT now(),
      disconnected_at TIMESTAMPTZ
    )
  `;

  // Backfill: add columns for databases created with older schema
  await sql`ALTER TABLE devices ADD COLUMN IF NOT EXISTS device_secret TEXT`;
  await sql`ALTER TABLE sessions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS pending BOOLEAN DEFAULT true`;
  await sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_approvals_event_id ON approvals(event_id)`;
  await sql`ALTER TABLE approvals ALTER COLUMN responder DROP NOT NULL`;

  // Pairing codes (one-time, server-generated)
  await sql`
    CREATE TABLE IF NOT EXISTS pairing_codes (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code_hash TEXT NOT NULL UNIQUE,
      device_id UUID NOT NULL REFERENCES devices(id),
      ip_address TEXT NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  // Device tokens (separate from device_secret)
  await sql`
    CREATE TABLE IF NOT EXISTS device_tokens (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      device_id UUID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
      token_type TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      label TEXT,
      last_used_at TIMESTAMPTZ,
      expires_at TIMESTAMPTZ,
      revoked BOOLEAN DEFAULT false,
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE INDEX IF NOT EXISTS idx_pairing_codes_code_hash ON pairing_codes(code_hash)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_device_tokens_token_hash ON device_tokens(token_hash)
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_events_session_pending ON events(session_id, pending)
  `;

  // ── Subscription system (Phase 1: account model) ──────────

  // users: central identity record; one row per human, regardless
  // of how many devices or provider accounts they have bound.
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id          BIGSERIAL    PRIMARY KEY,
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      deleted_at  TIMESTAMPTZ
    )
  `;

  // auth_identities: 3rd-party login handles (WeChat openid,
  // Feishu openid, etc). PK is (provider, openid) so the same
  // user can't accidentally get two rows for the same platform,
  // and re-login is idempotent.
  await sql`
    CREATE TABLE IF NOT EXISTS auth_identities (
      user_id     BIGINT       NOT NULL REFERENCES users(id),
      provider    VARCHAR(16)  NOT NULL,
      openid      VARCHAR(64)  NOT NULL,
      unionid     VARCHAR(64),
      created_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (provider, openid)
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_auth_identities_user_id ON auth_identities(user_id)
  `;

  // device_bindings: links an existing devices.id (UUID) to a
  // users.id. One user can bind many devices; one device can
  // only bind to one user at a time (unbound_at NULL = active).
  await sql`
    CREATE TABLE IF NOT EXISTS device_bindings (
      device_id   UUID         PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
      user_id     BIGINT       NOT NULL REFERENCES users(id),
      device_name VARCHAR(128),
      bound_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
      unbound_at  TIMESTAMPTZ
    )
  `;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_device_bindings_user_id ON device_bindings(user_id) WHERE unbound_at IS NULL
  `;

  // ── Subscription system (Phase 2: redeem codes + trial) ────

  // redeem_codes: pre-generated, one-shot redemption codes. Only
  // the SHA-256 of the plaintext is stored — the plaintext is shown
  // to the user exactly once (at mint time) and never again.
  await sql`
    CREATE TABLE IF NOT EXISTS redeem_codes (
      code_hash     VARCHAR(64)  PRIMARY KEY,
      product       VARCHAR(32)  NOT NULL,
      plan          VARCHAR(16)  NOT NULL,
      duration_days INTEGER      NOT NULL,
      status        VARCHAR(16)  NOT NULL DEFAULT 'unused',
      code_prefix   VARCHAR(8),
      code_last4    VARCHAR(4),
      batch_id      VARCHAR(32),
      note          VARCHAR(128),
      used_at       TIMESTAMPTZ,
      used_by       BIGINT       REFERENCES users(id),
      created_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_rc_product_status ON redeem_codes(product, status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_rc_batch ON redeem_codes(batch_id)`;

  // user_subscriptions: one row per (user, product). Source describes
  // how the subscription was acquired; status (active/expired) is
  // derived from expires_at > now().
  await sql`
    CREATE TABLE IF NOT EXISTS user_subscriptions (
      user_id     BIGINT       NOT NULL REFERENCES users(id),
      product     VARCHAR(32)  NOT NULL,
      plan        VARCHAR(16),
      expires_at  TIMESTAMPTZ  NOT NULL,
      source      VARCHAR(24),
      updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, product)
    )
  `;

  // redeem_logs: append-only audit of every redemption attempt that
  // actually changed expires_at. Failed attempts (invalid/used code)
  // are not logged here — those are visible via 4xx metrics.
  await sql`
    CREATE TABLE IF NOT EXISTS redeem_logs (
      id                BIGSERIAL    PRIMARY KEY,
      code_hash         VARCHAR(64)  NOT NULL,
      user_id           BIGINT       NOT NULL REFERENCES users(id),
      product           VARCHAR(32)  NOT NULL,
      plan              VARCHAR(16),
      duration_days     INTEGER,
      before_expires_at TIMESTAMPTZ,
      after_expires_at  TIMESTAMPTZ,
      created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_rl_created ON redeem_logs(created_at)`;

  // trial_claims: one row per (user, product) at most. Inserted
  // exactly once on the user's first successful claim-device, and
  // never again (ON CONFLICT DO NOTHING). The 14-day window is
  // encoded in the DEFAULT below; getEntitlement() reads it directly.
  await sql`
    CREATE TABLE IF NOT EXISTS trial_claims (
      user_id     BIGINT       NOT NULL REFERENCES users(id),
      product     VARCHAR(32)  NOT NULL,
      started_at  TIMESTAMPTZ  NOT NULL DEFAULT now(),
      expires_at  TIMESTAMPTZ  NOT NULL DEFAULT now() + interval '14 days',
      PRIMARY KEY (user_id, product)
    )
  `;

  // ── Subscription system (Phase 3: approval quota) ──────────

  // approval_usage: per-(user, product, period) counter of approval
  // events that passed through the server. The period is a CHAR(7)
  // "YYYY-MM" string so the counter resets cleanly at the month
  // boundary without any scheduled job. Free-tier users get a 50/
  // month cap; trial/paid users skip the cap entirely (Phase 3
  // design — see docs/plans/subscription-implementation-slices.md).
  await sql`
    CREATE TABLE IF NOT EXISTS approval_usage (
      user_id   BIGINT       NOT NULL REFERENCES users(id),
      product   VARCHAR(32)  NOT NULL DEFAULT 'codekey',
      period    CHAR(7)      NOT NULL,
      count     INTEGER      NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, product, period)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_au_product_period ON approval_usage(product, period)`;

  // approval_events_dedup: idempotency log so the same logical
  // approval event isn't counted twice. Bridges send clientEventId
  // (shared by e.g. OpenCode's permission.asked and permission.updated
  // hooks) — the server dedups on that. Cleanup runs alongside
  // approval_usage (12-month retention) in runCleanup().
  await sql`
    CREATE TABLE IF NOT EXISTS approval_events_dedup (
      user_id         BIGINT       NOT NULL REFERENCES users(id),
      product         VARCHAR(32)  NOT NULL DEFAULT 'codekey',
      period          CHAR(7)      NOT NULL,
      client_event_id VARCHAR(64)  NOT NULL,
      created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, product, period, client_event_id)
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_aed_period ON approval_events_dedup(period)`;

  console.log('Database migrations complete');
  return sql;
}
