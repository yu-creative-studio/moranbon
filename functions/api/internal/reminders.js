// Apps Script から呼ぶ。共有シークレット（ヘッダー X-Moranbon-Secret）必須
// GET  /api/internal/reminders?date=YYYY-MM-DD  … その日の未送信の予約（省略時は明日）
// POST /api/internal/reminders  {"ids":[...]}    … 送信済みにする
//      {"purge": true} を付けると、来店日から1年過ぎた予約データも削除する
import { handle, json, readJson, requireInternal, fail } from '../../_lib/http.js';
import { reminderTargets, markReminded, purgeOld } from '../../_lib/db.js';
import { nowJst, addDays, isValidDate } from '../../_lib/rules.js';

export const onRequestGet = handle(async ({ request, env }) => {
  requireInternal(request, env);
  const date = new URL(request.url).searchParams.get('date') || addDays(nowJst().date, 1);
  if (!isValidDate(date)) return fail('日付が正しくありません');
  const list = await reminderTargets(env.DB, date);
  return json({ ok: true, date, bookings: list.map(({ id, code, date, start_time, party_size, name_kana, email }) =>
    ({ id, code, date, start_time, party_size, name_kana, email })) });
});

export const onRequestPost = handle(async ({ request, env }) => {
  requireInternal(request, env);
  const b = await readJson(request);
  const marked = await markReminded(env.DB, Array.isArray(b.ids) ? b.ids.map(Number) : []);
  const purged = b.purge ? await purgeOld(env.DB, nowJst()) : 0;
  return json({ ok: true, marked, purged });
});
