import './env.js'; // 必須第一個載入
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { routes } from './api.js';
import { verifySignature, handleEvents } from './line.js';
import { initDb } from './db.js';

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));
const MAX_BODY = 1024 * 1024; // 1MB

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('請求內容過大'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 前端和後端共用同一份分攤演算法，避免預覽金額和實際入帳不一致
const SETTLE_JS = fileURLToPath(new URL('./settle.js', import.meta.url));

async function serveStatic(res, urlPath) {
  if (urlPath === '/settle.js') {
    const data = await readFile(SETTLE_JS);
    res.writeHead(200, { 'Content-Type': MIME['.js'], 'Cache-Control': 'no-cache' });
    res.end(data);
    return;
  }
  const rel = urlPath === '/' ? 'index.html' : normalize(urlPath).replace(/^([/\\.])+/, '');
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const data = await readFile(file);
    res.writeHead(200, {
      'Content-Type': MIME[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found');
  }
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

  try {
    // LINE webhook：必須用原始 bytes 驗簽
    if (req.method === 'POST' && url.pathname === '/webhook') {
      const raw = await readBody(req);
      if (!verifySignature(raw, req.headers['x-line-signature'])) {
        res.writeHead(401).end('bad signature');
        return;
      }
      res.writeHead(200).end('OK'); // 先回 200，LINE 只等 1 秒
      const payload = JSON.parse(raw.toString('utf8'));
      handleEvents(payload.events || []).catch((e) => console.error('[webhook]', e));
      return;
    }

    if (url.pathname.startsWith('/api/')) {
      const handler = routes[`${req.method} ${url.pathname}`];
      if (!handler) return sendJson(res, 404, { error: '沒有這個 API' });
      const raw = await readBody(req);
      let body;
      try {
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      } catch {
        return sendJson(res, 400, { error: 'JSON 格式錯誤' });
      }
      const result = await handler(body);
      return sendJson(res, 200, result);
    }

    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' }).end('ok');
      return;
    }

    if (req.method === 'GET') return serveStatic(res, url.pathname);
    res.writeHead(405).end('Method not allowed');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error('[server]', err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || '伺服器錯誤' });
  }
});

await initDb();

server.listen(PORT, () => {
  console.log(`分帳機器人啟動：http://localhost:${PORT}`);
  if (!process.env.LINE_CHANNEL_SECRET) console.log('  ⚠ 尚未設定 LINE_CHANNEL_SECRET（webhook 會拒絕所有請求）');
  if (process.env.DEV_USER) console.log(`  ⚠ 開發模式：跳過 LINE 身分驗證，使用者 = ${process.env.DEV_USER}`);
});
