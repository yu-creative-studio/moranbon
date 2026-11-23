// POST /api/bookings  予約作成
import { handle, json, fail, readJson } from '../../_lib/http.js';
import { createBooking } from '../../_lib/db.js';
import { nowJst, validateGuest } from '../../_lib/rules.js';
import { notifyLater } from '../../_lib/notify.js';

export const onRequestPost = handle(async (ctx) => {
  const body = await readJson(ctx.request);
  if (body.website) return fail('送信できませんでした', 400); // ボット対策（見えない入力欄）
  if (body.agree !== true) return fail('個人情報の取り扱いに同意してください');
  const guest = validateGuest(body);
  if (!guest.ok) return fail('入力内容をご確認ください', 422, { fields: guest.errors });

  const result = await createBooking(ctx.env.DB, body, guest.value, nowJst());
  if (result.error) return fail(result.error, result.full ? 409 : 400);

  const b = result.booking;
  notifyLater(ctx, 'booked', b);
  return json({
    ok: true,
    booking: { code: b.code, date: b.date, start_time: b.start_time, party_size: b.party_size, name_kana: b.name_kana, email: b.email },
  }, 201);
});
