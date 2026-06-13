/**
 * Mock Relay Proxy — 本地代理，劫持 history-policy 请求，其余透传远程 relay
 *
 * 用法:
 *   node scripts/mock-relay.mjs --mode=404       # history policy 接口返回 404
 *   node scripts/mock-relay.mjs --mode=ignore    # history policy HTTP 超时不返回
 *   node scripts/mock-relay.mjs --mode=broken    # history policy 返回 500 / 乱码
 *   node scripts/mock-relay.mjs --mode=passthrough # 全部透传（用于验证 mock 本身不影响正常功能）
 *
 * 默认监听 :9999，用 RELAY_TARGET 环境变量指定上游 relay 地址：
 *   $env:RELAY_TARGET = "https://codekey.tinymoney.cn"; node scripts/mock-relay.mjs --mode=404
 *
 * VS Code 中修改 relayUrl 为 http://localhost:9999 即可将 bridge 指向 mock。
 */
/**
 * Mock Relay Proxy — 本地代理，劫持 history-policy 请求，其余透传远程 relay
 *
 * 用法:
 *   node scripts/mock-relay.js --mode=404       # history policy 接口返回 404
 *   node scripts/mock-relay.js --mode=ignore    # history policy HTTP 超时不返回
 *   node scripts/mock-relay.js --mode=broken    # history policy 返回 500 / 乱码
 *   node scripts/mock-relay.js --mode=passthrough # 全部透传（用于验证 mock 本身不影响正常功能）
 *
 * 默认监听 :9999，用 RELAY_TARGET 环境变量指定上游 relay 地址：
 *   $env:RELAY_TARGET = "https://codekey.tinymoney.cn"
 *   node scripts/mock-relay.js --mode=404
 *
 * VS Code 中修改 relayUrl 为 http://localhost:9999 即可将 bridge 指向 mock。
 */
const http = require('http');
const https = require('https');

const MODE = process.argv.find(a => a.startsWith('--mode='))?.split('=')[1] ?? '404';
const PORT = parseInt(process.env.MOCK_PORT || '9999', 10);
const TARGET = process.env.RELAY_TARGET || 'https://codekey.tinymoney.cn';
const TARGET_URL = new URL(TARGET);
const isTargetHttps = TARGET_URL.protocol === 'https:';
const transport = isTargetHttps ? https : http;

function historyPolicyPath(pathname) {
  return pathname === '/v1/history-policies' || pathname.startsWith('/v1/history-policy');
}

function modeResponse(mode) {
  if (mode === '404') return { status: 404, body: '{"error":"not found"}' };
  if (mode === 'broken') return { status: 500, body: 'Internal Server Error (mock)' };
  if (mode === 'garbage') return { status: 200, body: '<html>not json at all</html>' };
  return null; // passthrough
}

function proxyHttp(req, res) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const hpMatch = historyPolicyPath(parsed.pathname);

  if (hpMatch) {
    const mr = modeResponse(MODE);
    if (mr) {
      if (MODE === 'ignore') {
        return;
      }
      res.writeHead(mr.status, { 'Content-Type': 'application/json' });
      res.end(mr.body);
      return;
    }
  }

  const options = {
    hostname: TARGET_URL.hostname,
    port: TARGET_URL.port || (isTargetHttps ? 443 : 80),
    path: req.url,
    method: req.method,
    headers: { ...req.headers },
    rejectUnauthorized: false,
  };

  const proxyReq = transport.request(options, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    console.error('[mock] proxy error:', err.message);
    if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Bad Gateway');
  });
  req.pipe(proxyReq);
}

function proxyWs(req, socket, head) {
  const parsed = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  const options = {
    hostname: TARGET_URL.hostname,
    port: TARGET_URL.port || (isTargetHttps ? 443 : 80),
    path: parsed.pathname + (parsed.search || ''),
    method: 'CONNECT',
    headers: { ...req.headers },
    rejectUnauthorized: false,
  };

  const proxyReq = transport.request(options);
  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    const origWrite = proxySocket.write.bind(proxySocket);
    proxySocket.write = function (data, ...args) {
      const msg = data.toString('utf8');
      if (msg.includes('sync_history_policy')) {
        if (MODE === 'ignore') {
          console.log('[mock] WS sync_history_policy silently dropped');
          return true;
        }
        if (MODE === 'broken') {
          console.log('[mock] WS sync_history_policy → closing socket');
          proxySocket.destroy();
          return true;
        }
      }
      return origWrite(data, ...args);
    };

    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      '\r\n'
    );
    socket.pipe(proxySocket).pipe(socket);
    if (proxyHead?.length) proxySocket.write(proxyHead);
  });
  proxyReq.on('error', (err) => {
    console.error('[mock] WS proxy error:', err.message);
    socket.destroy();
  });
  proxyReq.end();
}

const server = http.createServer(proxyHttp);
server.on('upgrade', proxyWs);
server.listen(PORT, () => {
  console.log(`mock-relay [mode=${MODE}] listening on :${PORT} → ${TARGET}`);
});
