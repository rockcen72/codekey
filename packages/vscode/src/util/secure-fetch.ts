import * as tls from 'node:tls';
import * as http from 'node:http';
import { URL } from 'node:url';
import { log } from '../log.js';

/**
 * Like globalThis.fetch, but with per-host TLS verification bypass.
 *
 * If the target host appears in CODEKEY_INSECURE_TLS_HOSTS (comma-separated),
 * the request is issued with rejectUnauthorized: false. All other hosts
 * enforce strict TLS.
 *
 * Used to talk to the production relay when its certificate SAN does not
 * include the bare IP we connect to (e.g., domain still in ICP filing).
 * Once the relay is served from a hostname that matches its cert, drop the
 * env var and switch back to globalThis.fetch.
 *
 * Non-HTTPS and localhost URLs are passed through to global fetch unchanged.
 *
 * Implementation note: VS Code's extension host runs in Electron, and
 * Electron's `https.request` (and globalThis.fetch) is sometimes routed
 * through Chromium's network stack which ignores the `agent` parameter
 * on `https.request`. We instead build the TLS socket ourselves with
 * `tls.connect({ rejectUnauthorized: false })` so the bypass actually
 * takes effect in the extension host.
 */
function parseInsecureHosts(): string[] {
  return (process.env.CODEKEY_INSECURE_TLS_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

interface FetchResponseLike {
  status: number;
  statusText: string;
  ok: boolean;
  headers: Headers;
  bodyText: string;
}

function buildRequest(
  url: URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): { headers: Record<string, string>; body: string | Buffer | undefined } {
  const headers: Record<string, string> = {
    host: url.host,
  };
  if (init?.headers) {
    const h = init.headers;
    if (h instanceof Headers) {
      h.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) headers[k.toLowerCase()] = v;
    } else {
      for (const [k, v] of Object.entries(h as Record<string, string>)) {
        headers[k.toLowerCase()] = v;
      }
    }
  }
  let body: string | Buffer | undefined;
  if (init?.body != null) {
    if (typeof init.body === 'string') body = init.body;
    else if (Buffer.isBuffer(init.body)) body = init.body;
    else if (init.body instanceof URLSearchParams) body = init.body.toString();
    else body = String(init.body);
    if (!('content-length' in headers) && body.length > 0) {
      headers['content-length'] = String(Buffer.byteLength(body));
    }
  }
  return { headers, body };
}

function rawHttpsRequest(
  url: URL,
  init: RequestInit | undefined,
  timeoutMs: number,
): Promise<FetchResponseLike> {
  const { headers, body } = buildRequest(url, init, timeoutMs);
  const insecureHosts = parseInsecureHosts();
  const skipVerify = insecureHosts.includes(url.hostname);
  log(`[secure-fetch]   raw https — skipVerify=${skipVerify} (hosts=${JSON.stringify(insecureHosts)})`);

  return new Promise<FetchResponseLike>((resolve, reject) => {
    const port = url.port ? Number(url.port) : 443;
    // SNI: use the URL hostname. If it's an IP, RFC 6066 forbids SNI; pass
    // an empty string to suppress the deprecation warning while still
    // attempting handshake.
    const sni = /^[0-9.]+$/.test(url.hostname) ? '' : url.hostname;
    const socket = tls.connect({
      host: url.hostname,
      port,
      servername: sni || undefined,
      rejectUnauthorized: !skipVerify,
    });

    let aborted = false;
    const onAbort = () => {
      aborted = true;
      socket.destroy(new Error('aborted'));
    };
    if (init?.signal) {
      if (init.signal.aborted) {
        socket.destroy(new Error('aborted'));
        return;
      }
      init.signal.addEventListener('abort', onAbort);
    }
    const timer = setTimeout(() => {
      socket.destroy(new Error(`secure-fetch timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.on('secureConnect', () => {
      log(`[secure-fetch]   TLS established (authorized=${socket.authorized})`);
      const req = http.request({
        host: url.hostname,
        port,
        method: init?.method ?? 'GET',
        path: url.pathname + url.search,
        headers,
        // Create the request on our pre-connected TLS socket.
        createConnection: () => socket,
      });
      req.on('response', (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          clearTimeout(timer);
          if (init?.signal) init.signal.removeEventListener('abort', onAbort);
          if (aborted) return;
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((vv) => responseHeaders.append(k, String(vv)));
            else if (v != null) responseHeaders.set(k, String(v));
          }
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300,
            headers: responseHeaders,
            bodyText: body.toString(),
          });
        });
      });
      req.on('error', (err) => {
        clearTimeout(timer);
        if (!aborted) reject(err);
      });
      if (body !== undefined) req.write(body);
      req.end();
    });
    socket.on('error', (err) => {
      clearTimeout(timer);
      log(`[secure-fetch]   TLS error: ${err.message}`);
      if (!aborted) reject(err);
    });
  });
}

export async function secureFetch(
  input: string | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input;
  const timeoutMs = init?.timeoutMs ?? 10_000;

  log(`[secure-fetch] → ${init?.method ?? 'GET'} ${url.href}`);

  if (url.protocol !== 'https:') {
    log(`[secure-fetch]   (HTTP — using global fetch)`);
    return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    log(`[secure-fetch]   (localhost — using global fetch)`);
    return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  }

  // HTTPS — manual TLS so rejectUnauthorized actually applies in Electron.
  const result = await rawHttpsRequest(url, init, timeoutMs);
  // Adapt to the global Response interface used by callers. The raw
  // implementation already buffered the body; expose it as a fresh
  // ReadableStream-like so callers can call .text() / .json() as usual.
  return new Response(result.bodyText, {
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
  });
}
