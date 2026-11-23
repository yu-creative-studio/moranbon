// GET/POST /api/admin/settings  ネットに出す卓数など
import { requireAdmin, json, fail, readJson } from '../../_lib/http.js';
import { getSettings, saveSettings } from '../../_lib/db.js';

export const onRequestGet = requireAdmin(async ({ env }) => json({ ok: true, settings: await getSettings(env.DB) }));

export const onRequestPost = requireAdmin(async ({ request, env }) => {
  const b = await readJson(request);
  try { return json({ ok: true, settings: await saveSettings(env.DB, b) }); }
  catch (e) { return fail(e.message); }
});
