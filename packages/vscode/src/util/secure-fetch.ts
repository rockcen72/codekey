import * as https from 'node:https';
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
 * Localhost (127.0.0.1) and HTTP URLs are passed through unchanged.
 */
function parseInsecureHosts(): string[] {
  return (process.env.CODEKEY_INSECURE_TLS_HOSTS ?? '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);
}

function buildAgent(hostname: string): https.Agent | undefined {
  const insecureHosts = parseInsecureHosts();
  if (insecureHosts.includes(hostname)) {
    log(`[secure-fetch] TLS verify skipped for host ${hostname}`);
    return new https.Agent({ rejectUnauthorized: false });
  }
  log(`[secure-fetch] TLS verify ENFORCED for host ${hostname} (not in CODEKEY_INSECURE_TLS_HOSTS=${JSON.stringify(insecureHosts)})`);
  return undefined; // use globalAgent (strict verify)
}

function writeRequestBody(body: unknown): string | Buffer | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string') return body;
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof URLSearchParams) return body.toString();
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  // FormData / Blob / ReadableStream: fall back to global fetch which handles these.
  return undefined;
}

export async function secureFetch(
  input: string | URL,
  init?: RequestInit & { timeoutMs?: number },
): Promise<Response> {
  const url = typeof input === 'string' ? new URL(input) : input;
  const timeoutMs = init?.timeoutMs ?? 10_000;

  log(`[secure-fetch] → ${init?.method ?? 'GET'} ${url.href}`);

  // Non-HTTPS, or localhost: pass straight through to global fetch.
  if (url.protocol !== 'https:' || url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
    log(`[secure-fetch]   (passthrough to global fetch — non-HTTPS or localhost)`);
    const { timeoutMs: _drop, ...rest } = init ?? {};
    return fetch(input, { ...rest, signal: init?.signal ?? AbortSignal.timeout(timeoutMs) });
  }

  log(`[secure-fetch]   (HTTPS — using custom Agent)`);

  // HTTPS with potential bypass: use node:https with a per-host Agent.
  return new Promise<Response>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const h = init.headers;
      if (h instanceof Headers) {
        h.forEach((v, k) => { headers[k] = v; });
      } else if (Array.isArray(h)) {
        for (const [k, v] of h) headers[k] = v;
      } else {
        Object.assign(headers, h as Record<string, string>);
      }
    }
    const agent = buildAgent(url.hostname);
    const req = https.request(
      {
        hostname: url.hostname,
        port: url.port || 443,
        path: url.pathname + url.search,
        method: init?.method ?? 'GET',
        agent,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks);
          const responseHeaders = new Headers();
          for (const [k, v] of Object.entries(res.headers)) {
            if (Array.isArray(v)) v.forEach((vv) => responseHeaders.append(k, vv));
            else if (v != null) responseHeaders.set(k, String(v));
          }
          resolve(new Response(body, {
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }));
        });
      },
    );
    req.on('error', (err) => {
      log(`[secure-fetch]   error: ${err.message}`);
      reject(err);
    });
    req.on('close', () => {
      log(`[secure-fetch]   socket closed`);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`secure-fetch timeout after ${timeoutMs}ms`));
    });
    if (init?.signal) {
      if (init.signal.aborted) {
        req.destroy(new Error('aborted'));
        return;
      }
      init.signal.addEventListener('abort', () => req.destroy(new Error('aborted')));
    }

    const body = writeRequestBody(init?.body);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

// Silence unused-import lint for http (kept for future HTTP-only fallbacks).
void http;
