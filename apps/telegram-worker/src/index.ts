interface AssetBinding {
  fetch(request: Request): Promise<Response>;
}

interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_LOGIN_SECRET: string;
  RELAY_BACKEND_URL: string;
  BOT_SETUP_KEY?: string;
  ASSETS: AssetBinding;
}

interface TelegramUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8' };
const MAX_INIT_DATA_AGE_SECONDS = 24 * 60 * 60;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders(request) });
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === '/health') {
        return json({ status: 'ok', service: 'codekey-telegram-gateway' }, request, env);
      }
      if (url.pathname === '/auth/telegram' && request.method === 'POST') {
        return await handleTelegramLogin(request, env);
      }
      if (url.pathname === '/admin/setup-bot' && request.method === 'POST') {
        return await handleBotSetup(request, env);
      }
      if (isProxyRoute(url.pathname)) {
        return await proxyToRelay(request, env, normalizeRelayPath(url.pathname));
      }
      return env.ASSETS.fetch(request);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error';
      return json({ error: message }, request, env, 500);
    }
  },

  // Cron trigger: polls relay for pending Telegram notifications every 30s.
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    console.log('telegram-notify: cron triggered');
    const secret = env.TELEGRAM_LOGIN_SECRET;
    const relayUrl = env.RELAY_BACKEND_URL;
    if (!secret || !relayUrl) return;

    const resp = await fetch(`${relayUrl}/api/v1/telegram/pending-events`, {
      headers: { 'x-codekey-telegram-secret': secret },
      signal: AbortSignal.timeout(15_000),
    });
    if (!resp.ok) {
      console.error('telegram-notify: fetch failed', resp.status);
      return;
    }
    const events = await resp.json() as Array<{
      eventId: string; sessionId: string; summary: string; risk: string; telegramId: string;
    }>;
    if (!events.length) return;
    console.log('telegram-notify: sending', events.length, 'notifications');

    const apiBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
    const miniappUrl = `https://${new URL(relayUrl).host}`;

    for (const ev of events) {
      const text = `🔔 Approval Request${ev.risk ? ` [${ev.risk}]` : ''}\n\n${(ev.summary || '').slice(0, 200)}`;
      const result = await fetch(`${apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chat_id: ev.telegramId,
          text,
          reply_markup: {
            inline_keyboard: [[
              { text: 'View', web_app: { url: `${miniappUrl}/?sessionId=${ev.sessionId}&eventId=${ev.eventId}` } },
            ]],
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!result.ok) {
        const body = await result.text().catch(() => '');
        console.error('telegram-notify: send failed for', ev.eventId, result.status, body);
      }
    }
  },
};

async function handleTelegramLogin(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { initData?: string } | null;
  if (!body?.initData) {
    return json({ error: 'initData required' }, request, env, 400);
  }

  const verified = await verifyInitData(body.initData, env.TELEGRAM_BOT_TOKEN);
  const relayResp = await fetch(`${trimSlash(env.RELAY_BACKEND_URL)}/api/v1/auth/telegram`, {
    method: 'POST',
    headers: {
      ...JSON_HEADERS,
      'x-codekey-telegram-secret': env.TELEGRAM_LOGIN_SECRET,
    },
    body: JSON.stringify({
      telegramId: verified.user.id,
      username: verified.user.username,
      firstName: verified.user.first_name,
      lastName: verified.user.last_name,
      authDate: verified.authDate,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  return withCors(relayResp, request, env);
}

// ── POST /admin/setup-bot ───────────────────────────────────
// One-shot setup: configures the Telegram Bot via Bot API.
// Requires a setupKey in the request body that matches env.BOT_SETUP_KEY.
// Call: curl -X POST 'https://codekeyapi.ccwu.cc/admin/setup-bot' \
//          -H 'Content-Type: application/json' \
//          -d '{"setupKey":"<your-setup-key>"}'
async function handleBotSetup(request: Request, env: Env): Promise<Response> {
  const body = (await request.json().catch(() => null)) as { setupKey?: string } | null;
  if (!body?.setupKey || body.setupKey !== env.BOT_SETUP_KEY) {
    return json({ error: 'invalid setup key' }, request, env, 403);
  }

  const apiBase = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`;
  const miniappUrl = `${new URL(request.url).origin}`;
  const results: Record<string, unknown> = {};

  // 1. Set menu button — persistent button at bottom of chat
  const menu = await fetch(`${apiBase}/setChatMenuButton`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      menu_button: {
        type: 'web_app',
        text: 'CodeKey',
        web_app: { url: miniappUrl },
      },
    }),
  });
  results.menuButton = await menu.json();

  // 2. Set bot name
  const name = await fetch(`${apiBase}/setMyName`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'CodeKey' }),
  });
  results.botName = await name.json();

  // 3. Set bot description
  const desc = await fetch(`${apiBase}/setMyDescription`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      description:
        'Remotely approve Claude Code, Codex, and OpenCode requests from your phone. '
        + 'Pair your VS Code device via a pairing code, then review sessions, approve or '
        + 'deny AI coding assistant requests, and send commands — all from Telegram.',
    }),
  });
  results.botDescription = await desc.json();

  // 4. Verify the bot commands endpoint exists
  const botInfo = await fetch(`${apiBase}/getMe`);
  results.botInfo = await botInfo.json();

  return json({ ok: true, miniappUrl, results }, request, env);
}

async function verifyInitData(initData: string, botToken: string): Promise<{ user: TelegramUser; authDate: number }> {
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  const userJson = params.get('user');
  const authDateRaw = params.get('auth_date');

  if (!hash || !userJson || !authDateRaw) {
    throw new Error('invalid initData');
  }

  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate)) {
    throw new Error('invalid auth_date');
  }
  const age = Math.floor(Date.now() / 1000) - authDate;
  if (age > MAX_INIT_DATA_AGE_SECONDS) {
    throw new Error('initData expired');
  }

  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = await hmacSha256(new TextEncoder().encode('WebAppData'), botToken);
  const computed = await hmacSha256(secretKey, dataCheckString);
  if (toHex(computed) !== hash) {
    throw new Error('initData signature mismatch');
  }

  const user = JSON.parse(userJson) as TelegramUser;
  if (!Number.isInteger(user.id) || user.id <= 0) {
    throw new Error('invalid telegram user');
  }

  return { user, authDate };
}

async function proxyToRelay(request: Request, env: Env, relayPath: string): Promise<Response> {
  const source = new URL(request.url);
  const target = new URL(`${trimSlash(env.RELAY_BACKEND_URL)}${relayPath}`);
  target.search = source.search;

  const headers = new Headers(request.headers);
  headers.delete('host');
  const proxied = new Request(target, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const resp = await fetch(proxied);
  return withCors(resp, request, env);
}

function isProxyRoute(pathname: string): boolean {
  return (
    pathname.startsWith('/api/v1/user/') ||
    pathname.startsWith('/api/v1/events/') ||
    pathname === '/api/v1/user/devices' ||
    pathname === '/api/v1/subscription' ||
    pathname === '/api/v1/devices/confirm' ||
    pathname === '/api/v1/auth/claim-device' ||
    pathname === '/devices/confirm' ||
    pathname === '/auth/claim-device'
  );
}

function normalizeRelayPath(pathname: string): string {
  if (pathname === '/devices/confirm') return '/api/v1/devices/confirm';
  if (pathname === '/auth/claim-device') return '/api/v1/auth/claim-device';
  return pathname;
}

function corsHeaders(request: Request): HeadersInit {
  const requestOrigin = request.headers.get('origin');
  return {
    'access-control-allow-origin': requestOrigin || '*',
    'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS',
    'access-control-allow-headers': 'authorization,content-type',
    'access-control-max-age': '86400',
  };
}

function json(body: unknown, request: Request, env: Env, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...JSON_HEADERS, ...corsHeaders(request) },
  });
}

function withCors(response: Response, request: Request, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function hmacSha256(key: BufferSource, data: string | BufferSource): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const payload = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return crypto.subtle.sign('HMAC', cryptoKey, payload);
}

function toHex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
