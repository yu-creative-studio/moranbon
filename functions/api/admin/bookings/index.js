// GET /api/admin/bookings?date=YYYY-MM-DD  その日の予約一覧と残り枠
import { requireAdmin, json, fail } from '../../../_lib/http.js';
import { bookingsOn, availability, getSettings } from '../../../_lib/db.js';
import { nowJst, isValidDate, regularHoliday } from '../../../_lib/rules.js';

export const onRequestGet = requireAdmin(async ({ request, env }) => {
  const now = nowJst();
  const date = new URL(request.url).searchParams.get('date') || now.date;
  if (!isValidDate(date)) return fail('日付が正しくありません');
  const [bookings, settings] = await Promise.all([bookingsOn(env.DB, date), getSettings(env.DB)]);
  // 管理画面では、時刻による締め切りを無視して残り枠を見る
  const [day] = await availability(env.DB, date, date, { date, minutes: -9999, ms: now.ms });
  return json({ ok: true, date, holiday: regularHoliday(date), settings, day, bookings });
});
