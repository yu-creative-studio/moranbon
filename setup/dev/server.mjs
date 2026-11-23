// ローカル確認用の簡易サーバー（Cloudflare Pages + Functions + D1 の代わり）
//   node setup/dev/server.mjs [port]
// ・静的ファイルはリポジトリ直下から配信
// ・functions/ 以下を Pages Functions と同じ規則でルーティング
// ・D1 は node:sqlite で代用（setup/dev/dev.sqlite に保存。--memory で毎回まっさら）
// ・Apps Script への通知は /__gas で受け取り、GET /__gas で中身を見られる
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { D1 } from './d1.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.argv.find((a) => /^\d+$/.test(a)) || 8788);
const MEMORY = process.argv.includes('--memory');

const db = new D1(MEMORY ? ':memory:' : path.join(ROOT, 'setup/dev/dev.sqlite'));
const gasInbox = [];
const env = {
  DB: db,
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || 'moranbon-dev',
  SESSION_SECRET: process.env.SESSION_SECRET || 'dev-session-secret-0123456789abcdef0123',
  GAS_SECRET: process.env.GAS_SECRET || 'dev-gas-secret-0123456789abcdef',
  GAS_WEBHOOK_URL: `http://127.0.0.1:${PORT}/__gas`,
};

// ---- functions/ のルーティング ----
function collectRoutes(dir, base = '') {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith('_')) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { out.push(...collectRoutes(full, `${base}/${ent.name}`)); continue; }
    if (!ent.name.endsWith('.js')) continue;
    const name = ent.name.replace(/\.js$/, '');
    const segs = (name === 'index' ? base : `${base}/${name}`).split('/').filter(Boolean);
    out.push({ file: full, segs });
  }
  // 固定のパスを先に、[[catchall]] を最後に
  return out.sort((a, b) => score(b.segs) - score(a.segs));
}
const score = (segs) => segs.reduce((s, x) => s + (x.startsWith('[[') ? 0 : x.startsWith('[') ? 1 : 3), 0) + segs.length * 0.1;
function match(route, parts) {
  const params = {};
  for (let i = 0; i < route.segs.length; i++) {
    const seg = route.segs[i];
    if (seg.startsWith('[[')) { params[seg.slice(2, -2)] = parts.slice(i); return params; }
    if (i >= parts.length) return null;
    if (seg.startsWith('[')) params[seg.slice(1, -1)] = parts[i];
    else if (seg !== parts[i]) return null;
  }
  return route.segs.length === parts.length ? params : null;
}
const routes = collectRoutes(path.join(ROOT, 'functions'));

const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const chunks = []; for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks);

  if (url.pathname === '/__gas') {
    if (req.method === 'POST') gasInbox.push(JSON.parse(body.toString() || '{}'));
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(req.method === 'POST' ? { ok: true } : gasInbox));
  }

  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  for (const r of routes) {
    const params = match(r, parts);
    if (!params) continue;
    const mod = await import(pathToFileURL(r.file).href);
    const m = req.method[0] + req.method.slice(1).toLowerCase();
    const fn = mod[`onRequest${m}`] || mod.onRequest;
    if (!fn) { res.writeHead(405); return res.end('Method not allowed'); }
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
    headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');
    const request = new Request(url, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
    const waits = [];
    const response = await fn({ request, env, params, waitUntil: (p) => waits.push(p), next: () => null, data: {} });
    await Promise.allSettled(waits);
    const h = {}; response.headers.forEach((v, k) => { h[k] = v; });
    res.writeHead(response.status, h);
    return res.end(Buffer.from(await response.arrayBuffer()));
  }

  let file = path.join(ROOT, url.pathname);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end('Not found'); }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(PORT, '127.0.0.1', () => console.log(`MORANBON dev: http://127.0.0.1:${PORT}/  (admin password: ${env.ADMIN_PASSWORD})`));
