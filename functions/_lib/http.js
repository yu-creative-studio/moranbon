// レスポンス・認証・回数制限の共通部品

export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });

export const fail = (message, status = 400, extra = {}) => json({ ok: false, error: message, ...extra }, status);

export async function readJson(request) {
  const type = request.headers.get('content-type') || '';
  if (!type.includes('application/json')) throw new HttpError('JSONで送信してください', 415);
  const text = await request.text();
  if (text.length > 10000) throw new HttpError('送信データが大きすぎます', 413);
  try { return JSON.parse(text); } catch { throw new HttpError('送信データが正しくありません', 400); }
}

export class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// 例外を JSON のエラーに変える
export const handle = (fn) => async (ctx) => {
  try {
    if (!ctx.env.DB) return fail('予約データベース（D1）が接続されていません', 500);
    return await fn(ctx);
  } catch (e) {
    if (e instanceof HttpError) return fail(e.message, e.status);
    console.error(e);
    return fail('サーバーでエラーが起きました。時間をおいてお試しください', 500);
  }
};

export const clientIp = (request) =>
  request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for')?.split(',')[0].trim() || 'unknown';

// ---- 管理画面のセッション（署名付きCookie） ----
const COOKIE = 'mb_admin';
const SESSION_DAYS = 30;
const enc = new TextEncoder();

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// 長さが違っても時間が変わらない比較
export function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

const sessionSecret = (env) => {
  const s = env.SESSION_SECRET;
  if (!s || s.length < 32) throw new HttpError('SESSION_SECRET が設定されていません（32文字以上）', 500);
  return s;
};

export async function makeSessionCookie(env, nowMs = Date.now()) {
  const exp = Math.floor(nowMs / 1000) + SESSION_DAYS * 86400;
  const payload = `v1.${exp}`;
  const sig = await hmac(sessionSecret(env), payload);
  return `${COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}`;
}

export const clearSessionCookie = () => `${COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;

export async function isAdmin(request, env, nowMs = Date.now()) {
  const raw = (request.headers.get('cookie') || '').split(/;\s*/).find((c) => c.startsWith(COOKIE + '='));
  if (!raw) return false;
  const value = raw.slice(COOKIE.length + 1);
  const i = value.lastIndexOf('.');
  if (i < 0) return false;
  const payload = value.slice(0, i), sig = value.slice(i + 1);
  const [ver, exp] = payload.split('.');
  if (ver !== 'v1' || !(Number(exp) > nowMs / 1000)) return false;
  return safeEqual(sig, await hmac(sessionSecret(env), payload));
}

export const requireAdmin = (fn) => handle(async (ctx) => {
  if (!(await isAdmin(ctx.request, ctx.env))) return fail('ログインしてください', 401);
  return fn(ctx);
});

// ---- ログイン試行の回数制限：同じIPから15分に5回まで ----
export const LOGIN_WINDOW_SEC = 15 * 60;
export const LOGIN_MAX_FAILS = 5;

export async function loginBlocked(db, ip, nowSec) {
  await db.prepare('DELETE FROM login_attempts WHERE at < ?1').bind(nowSec - 86400).run();
  const row = await db.prepare('SELECT COUNT(*) AS n FROM login_attempts WHERE ip = ?1 AND at > ?2')
    .bind(ip, nowSec - LOGIN_WINDOW_SEC).first();
  return row.n >= LOGIN_MAX_FAILS;
}
export const recordLoginFail = (db, ip, nowSec) =>
  db.prepare('INSERT INTO login_attempts (ip, at) VALUES (?1, ?2)').bind(ip, nowSec).run();
export const clearLoginFails = (db, ip) =>
  db.prepare('DELETE FROM login_attempts WHERE ip = ?1').bind(ip).run();

// Apps Script など内部からの呼び出し（共有シークレット）
export function requireInternal(request, env) {
  const given = request.headers.get('x-moranbon-secret') || '';
  if (!env.GAS_SECRET || env.GAS_SECRET.length < 24) throw new HttpError('GAS_SECRET が設定されていません', 500);
  if (!safeEqual(given, env.GAS_SECRET)) throw new HttpError('認証に失敗しました', 403);
}
