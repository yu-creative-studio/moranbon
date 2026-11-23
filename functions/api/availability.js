// GET /api/availability?from=YYYY-MM-DD&to=YYYY-MM-DD
import { handle, json, fail } from '../_lib/http.js';
import { availability } from '../_lib/db.js';
import { nowJst, isValidDate, daysBetween, addDays } from '../_lib/rules.js';

export const onRequestGet = handle(async ({ request, env }) => {
  const url = new URL(request.url);
  const now = nowJst();
  let from = url.searchParams.get('from') || now.date;
  let to = url.searchParams.get('to') || addDays(from, 41);
  if (!isValidDate(from) || !isValidDate(to)) return fail('日付が正しくありません');
  if (from < now.date) from = now.date;
  if (to < from) return json({ ok: true, today: now.date, days: [] });
  if (daysBetween(from, to) > 62) return fail('一度に取得できるのは62日分までです');
  const days = await availability(env.DB, from, to, now);
  return json({ ok: true, today: now.date, days }, 200, { 'cache-control': 'no-store' });
});
