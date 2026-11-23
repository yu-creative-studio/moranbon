// GET /api/admin/me  ログイン中かどうか
import { handle, json, isAdmin } from '../../_lib/http.js';
import { nowJst } from '../../_lib/rules.js';
export const onRequestGet = handle(async ({ request, env }) =>
  json({ ok: true, admin: await isAdmin(request, env), today: nowJst().date }));
