// GET/POST/DELETE /api/admin/closures  臨時休業・貸切
import { requireAdmin, json, fail, readJson } from '../../_lib/http.js';
import { listClosures, addClosure, deleteClosure } from '../../_lib/db.js';
import { nowJst } from '../../_lib/rules.js';

export const onRequestGet = requireAdmin(async ({ env }) =>
  json({ ok: true, closures: await listClosures(env.DB, nowJst().date) }));

export const onRequestPost = requireAdmin(async ({ request, env }) => {
  const b = await readJson(request);
  const times = b.start_time == null || b.start_time === '' ? [null] : [].concat(b.start_time);
  try {
    for (const t of times) await addClosure(env.DB, b.date, t, b.reason, nowJst());
  } catch (e) { return fail(e.message); }
  return json({ ok: true, closures: await listClosures(env.DB, nowJst().date) }, 201);
});

export const onRequestDelete = requireAdmin(async ({ request, env }) => {
  const id = Number(new URL(request.url).searchParams.get('id'));
  if (!Number.isInteger(id)) return fail('id が正しくありません');
  await deleteClosure(env.DB, id);
  return json({ ok: true, closures: await listClosures(env.DB, nowJst().date) });
});
