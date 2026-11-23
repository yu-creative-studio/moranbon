// POST /api/admin/login
import { handle, json, fail, readJson, clientIp, safeEqual, makeSessionCookie,
  loginBlocked, recordLoginFail, clearLoginFails } from '../../_lib/http.js';

export const onRequestPost = handle(async ({ request, env }) => {
  if (!env.ADMIN_PASSWORD || env.ADMIN_PASSWORD.length < 8) return fail('ADMIN_PASSWORD が設定されていません', 500);
  const db = env.DB;
  const ip = clientIp(request);
  const nowSec = Math.floor(Date.now() / 1000);
  if (await loginBlocked(db, ip, nowSec)) return fail('ログインの失敗が続いたため、15分ほど待ってからお試しください', 429);
  const body = await readJson(request);
  if (!safeEqual(String(body.password || ''), env.ADMIN_PASSWORD)) {
    await recordLoginFail(db, ip, nowSec);
    return fail('パスワードが違います', 401);
  }
  await clearLoginFails(db, ip);
  return json({ ok: true }, 200, { 'set-cookie': await makeSessionCookie(env) });
});
