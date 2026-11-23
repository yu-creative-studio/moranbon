// GET  /api/admin/bookings?date=YYYY-MM-DD  その日の予約・卓・残り枠
// POST /api/admin/bookings  電話予約を予約表に入れる
import { requireAdmin, json, fail, readJson } from '../../../_lib/http.js';
import { bookingsOn, availability, getSettings, listTables, addPhoneBooking } from '../../../_lib/db.js';
import { nowJst, isValidDate, regularHoliday } from '../../../_lib/rules.js';

export const onRequestGet = requireAdmin(async ({ request, env }) => {
  const now = nowJst();
  const date = new URL(request.url).searchParams.get('date') || now.date;
  if (!isValidDate(date)) return fail('日付が正しくありません');
  const [bookings, settings, tables] = await Promise.all([bookingsOn(env.DB, date), getSettings(env.DB), listTables(env.DB)]);
  // 管理画面では、時刻による締め切りを無視して残り枠を見る
  const [day] = await availability(env.DB, date, date, { date, minutes: -9999, ms: now.ms });
  return json({ ok: true, date, holiday: regularHoliday(date), settings, day, bookings, tables });
});

export const onRequestPost = requireAdmin(async ({ request, env }) => {
  const body = await readJson(request);
  const r = await addPhoneBooking(env.DB, body, nowJst());
  if (r.error) return fail(r.error, r.status || 400);
  return json({ ok: true, booking: r.booking }, 201);
});
