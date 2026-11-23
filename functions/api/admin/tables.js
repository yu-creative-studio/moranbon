// GET/POST /api/admin/tables  卓の一覧と編集（名前・人数・ネット予約に使うか・並び順）
import { requireAdmin, json, fail, readJson } from '../../_lib/http.js';
import { listTables, saveTables } from '../../_lib/db.js';

export const onRequestGet = requireAdmin(async ({ env }) => json({ ok: true, tables: await listTables(env.DB, { all: true }) }));

export const onRequestPost = requireAdmin(async ({ request, env }) => {
  const b = await readJson(request);
  try { return json({ ok: true, tables: await saveTables(env.DB, b.tables) }); }
  catch (e) { return fail(e.message); }
});
