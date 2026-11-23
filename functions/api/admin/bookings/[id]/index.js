// PATCH /api/admin/bookings/:id  予約の移動・時間変更・内容の修正
import { requireAdmin, json, fail, readJson } from '../../../../_lib/http.js';
import { updateBooking } from '../../../../_lib/db.js';

export const onRequestPatch = requireAdmin(async ({ request, env, params }) => {
  const id = Number(params.id);
  if (!Number.isInteger(id)) return fail('予約が見つかりません', 404);
  const r = await updateBooking(env.DB, id, await readJson(request));
  if (r.error) return fail(r.error, r.status || 400);
  return json({ ok: true, booking: r.booking });
});
