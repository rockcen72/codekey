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
      created_at TIMESTAMPTZ DEFAULT now()
    )
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      event_id UUID REFERENCES events(id),
      session_id UUID REFERENCES sessions(id),
      decision TEXT NOT NULL,
      responder TEXT NOT NULL,
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

  console.log('Database migrations complete');
  return sql;
}
