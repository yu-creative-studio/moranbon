// POST /api/admin/logout
import { json, clearSessionCookie } from '../../_lib/http.js';
export const onRequestPost = () => json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
