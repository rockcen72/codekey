import * as tls from 'node:tls';
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

    // Accumulator for response data.
    const responseChunks: Buffer[] = [];
    let responseHeadersBuf = Buffer.alloc(0);

    socket.on('data', (chunk: Buffer) => {
      // Response data after headers are fully received.
      responseChunks.push(chunk);
    });

    socket.on('end', () => {
      clearTimeout(timer);
      if (init?.signal) init.signal.removeEventListener('abort', onAbort);
      if (aborted) return;
      // Parse the full response (headers + body).
      const raw = Buffer.concat([responseHeadersBuf, ...responseChunks]);
      const headerEnd = raw.indexOf('\r\n\r\n');
      if (headerEnd === -1) {
        return reject(new Error('secure-fetch: malformed response (no header terminator)'));
      }
      const headerText = raw.subarray(0, headerEnd).toString('utf-8');
      const bodyBuf = raw.subarray(headerEnd + 4);
      const headerLines = headerText.split('\r\n');
      const statusLine = headerLines.shift() ?? '';
      const statusMatch = statusLine.match(/^HTTP\/1\.[01] (\d{3})(?: (.*))?$/);
      const status = statusMatch ? Number(statusMatch[1]) : 0;
      const statusText = statusMatch?.[2] ?? '';
      const responseHeaders = new Headers();
      for (const line of headerLines) {
        const idx = line.indexOf(':');
        if (idx === -1) continue;
        const k = line.slice(0, idx).trim();
        const v = line.slice(idx + 1).trim();
        if (k) responseHeaders.append(k.toLowerCase(), v);
      }
      resolve({
        status,
        statusText,
        ok: status >= 200 && status < 300,
        headers: responseHeaders,
        bodyText: bodyBuf.toString('utf-8'),
      });
    });

    socket.on('error', (err) => {
      clearTimeout(timer);
      log(`[secure-fetch] TLS error to ${url.hostname}: ${err.message}`);
      if (!aborted) reject(err);
    });

    socket.on('secureConnect', () => {
      // Hand-craft the HTTP/1.1 request bytes and write to the TLS socket.
      // Using http.request over a TLS socket misbehaves in Electron 39.x
      // (the body is sent as plain HTTP and nginx rejects it with 400).
      // Writing the raw request bytes to the TLS socket avoids the layering.
      const method = init?.method ?? 'GET';
      const reqPath = url.pathname + url.search;
      const headerLines: string[] = [`${method} ${reqPath} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) {
        if (k === 'host') continue; // emit canonical host below
        headerLines.push(`${k}: ${v}`);
      }
      headerLines.push(`Host: ${url.host}`);
      headerLines.push(`Connection: close`);
      if (body && !('content-length' in headers)) {
        headerLines.push(`Content-Length: ${Buffer.byteLength(body)}`);
      }
      const reqBytes = Buffer.from(headerLines.join('\r\n') + '\r\n\r\n', 'utf-8');
      socket.write(reqBytes);
      if (body) {
        const bodyBytes = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf-8');
        socket.write(bodyBytes);
      }
      // The 'data' / 'end' events on the socket deliver the full TLS-decoded
      // HTTP response. We concatenate it in `responseChunks` and parse on 'end'.
      void responseHeadersBuf; // silence unused
    });
  });
}

export async function secureFetch(
  input: string | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input;
  const timeoutMs = init?.timeoutMs ?? 10_000;

  if (url.protocol !== 'https:') {
    return fetch(input, { ...init, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  }
  if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
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
