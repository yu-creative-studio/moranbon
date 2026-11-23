// POST /api/admin/bookings/:id/cancel  電話でキャンセルを受けたとき用
import { requireAdmin, json, fail } from '../../../../_lib/http.js';
import { cancelById } from '../../../../_lib/db.js';
import { nowJst } from '../../../../_lib/rules.js';
import { notifyLater } from '../../../../_lib/notify.js';

export const onRequestPost = requireAdmin(async (ctx) => {
  const id = Number(ctx.params.id);
  if (!Number.isInteger(id)) return fail('予約が見つかりません', 404);
  const result = await cancelById(ctx.env.DB, id, 'admin', nowJst());
  if (result.error) return fail(result.error, result.status);
  notifyLater(ctx, 'canceled', result.booking);
  return json({ ok: true, booking: result.booking });
});
