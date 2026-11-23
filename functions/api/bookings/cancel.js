// POST /api/bookings/cancel  予約番号＋電話番号でキャンセル
// action: "lookup"（内容の確認だけ）/ "cancel"（キャンセル実行）
import { handle, json, fail, readJson } from '../../_lib/http.js';
import { guestCancel } from '../../_lib/db.js';
import { nowJst, normalizePhone, canCancelOnline } from '../../_lib/rules.js';
import { notifyLater } from '../../_lib/notify.js';

const view = (b, now) => ({
  code: b.code, date: b.date, start_time: b.start_time, party_size: b.party_size,
  name_kana: b.name_kana, status: b.status, cancelable: b.status === 'confirmed' && canCancelOnline(b.date, b.start_time, now),
});

export const onRequestPost = handle(async (ctx) => {
  const body = await readJson(ctx.request);
  const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const phone = normalizePhone(body.phone);
  if (code.length !== 8 || phone.length < 10) return fail('予約番号（8桁）と電話番号を入力してください');
  const now = nowJst();
  const db = ctx.env.DB;

  if (body.action === 'lookup') {
    const b = await db.prepare('SELECT * FROM bookings WHERE code = ?1 AND phone = ?2').bind(code, phone).first();
    if (!b) return fail('予約が見つかりません。予約番号と電話番号をご確認ください', 404);
    return json({ ok: true, booking: view(b, now) });
  }

  const result = await guestCancel(db, code, phone, now);
  if (result.error) return fail(result.error, result.status, result.booking ? { booking: view(result.booking, now) } : {});
  notifyLater(ctx, 'canceled', result.booking);
  return json({ ok: true, booking: view(result.booking, now) });
});
