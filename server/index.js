'use strict';
/* IS6 计算后端（零依赖，只用 Node 内置模块）
 *   GET  /healthz     健康检查
 *   GET  /api/meta    数据规模 / schema 版本
 *   POST /api/calc    { relics, operators, ctx, damage } -> 面板 / 汇总 / 伤害
 *
 * 只监听 127.0.0.1，由 Nginx 反代；不直接对公网暴露。
 */
const http = require('http');
const { calc, meta } = require('./engine');
const { validateCalc, LIMITS } = require('./validate');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = Number(process.env.RATE_MAX) || 120;

/* ---------- 每 IP 限流（滑动窗口，内存有上限） ---------- */
const hits = new Map();      // ip -> number[]（时间戳）
let lastSweep = Date.now();

function sweep(now) {
  if (now - lastSweep < RATE_WINDOW_MS) return;
  lastSweep = now;
  if (hits.size > 5000) hits.clear();
  for (const [ip, arr] of hits) {
    const keep = arr.filter(t => now - t < RATE_WINDOW_MS);
    if (keep.length) hits.set(ip, keep);
    else hits.delete(ip);
  }
}

function rateLimited(ip, now) {
  sweep(now);
  const arr = (hits.get(ip) || []).filter(t => now - t < RATE_WINDOW_MS);
  if (arr.length >= RATE_MAX) {
    hits.set(ip, arr);
    return true;
  }
  arr.push(now);
  hits.set(ip, arr);
  return false;
}

/* ---------- 响应工具 ---------- */
function send(res, status, payload, extraHeaders) {
  const body = Buffer.from(JSON.stringify(payload));
  res.writeHead(status, Object.assign({
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  }, extraHeaders || {}));
  res.end(body);
}

function clientIp(req) {
  // 只有绑定 127.0.0.1 才有意义：这几项由本机 Nginx 写入，外部伪造不到
  const real = req.headers['x-real-ip'];
  if (typeof real === 'string' && real.length <= 45) return real;
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '');
}

function readBody(req) {
  // 超限时不立刻 destroy：那样客户端会看到连接重置而不是干净的 413。
  // 这里继续把剩余数据读完再回复；只有极端大（8 倍上限）才强断，防止被灌爆内存。
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooBig = false;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > LIMITS.maxBody) {
        tooBig = true;
        if (size > LIMITS.maxBody * 8) { req.destroy(); return; }
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ text: tooBig ? '' : Buffer.concat(chunks).toString('utf8'), tooBig }));
    req.on('error', reject);
  });
}

/* ---------- 路由 ---------- */
async function handle(req, res) {
  const started = Date.now();
  const url = req.url.split('?')[0];
  const ip = clientIp(req);

  res.on('finish', () => {
    if (process.env.LOG !== '0') {
      console.log(`${ip} ${req.method} ${url} ${res.statusCode} ${Date.now() - started}ms`);
    }
  });

  if (req.method === 'GET' && url === '/healthz') {
    return send(res, 200, { ok: true, uptime: Math.round(process.uptime()) });
  }

  if (req.method === 'GET' && url === '/api/meta') {
    return send(res, 200, Object.assign({ ok: true }, meta()));
  }

  if (url === '/api/calc') {
    if (req.method !== 'POST') return send(res, 405, { ok: false, error: '只接受 POST' }, { Allow: 'POST' });
    if (rateLimited(ip, Date.now())) {
      return send(res, 429, { ok: false, error: '请求过于频繁，请稍后再试' }, { 'Retry-After': '60' });
    }
    const ct = String(req.headers['content-type'] || '');
    if (!ct.includes('application/json')) {
      return send(res, 415, { ok: false, error: 'Content-Type 必须是 application/json' });
    }

    let read;
    try {
      read = await readBody(req);
    } catch (err) {
      return send(res, 400, { ok: false, error: '读取请求失败' });
    }
    if (read.tooBig) {
      return send(res, 413, { ok: false, error: '请求体过大' }, { Connection: 'close' });
    }
    const raw = read.text;

    let body;
    try {
      body = JSON.parse(raw);
    } catch (e) {
      return send(res, 400, { ok: false, error: 'JSON 解析失败' });
    }

    const v = validateCalc(body);
    if (!v.ok) return send(res, v.status, { ok: false, error: v.error });

    try {
      const result = calc(v.value);
      return send(res, 200, result);
    } catch (err) {
      console.error('calc failed:', err && err.stack ? err.stack : err);
      return send(res, 500, { ok: false, error: '计算失败' });
    }
  }

  return send(res, 404, { ok: false, error: 'not found' });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch(err => {
    console.error('unhandled:', err);
    if (!res.headersSent) send(res, 500, { ok: false, error: 'internal error' });
    else res.end();
  });
});

server.requestTimeout = 15000;
server.headersTimeout = 10000;

server.listen(PORT, HOST, () => {
  const m = meta();
  console.log(`is6-api listening on http://${HOST}:${PORT} | relics=${m.relics} operators=${m.operators} schema=${m.schemaVersion}`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log('shutting down...');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
