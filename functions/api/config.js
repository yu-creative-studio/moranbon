// GET /api/config  画面に表示するお店の情報・ルール（functions/shop.config.js から作る）
import { json } from '../_lib/http.js';
import { publicConfig } from '../_lib/config.js';

export const onRequestGet = () =>
  json({ ok: true, ...publicConfig }, 200, { 'cache-control': 'public, max-age=300' });
