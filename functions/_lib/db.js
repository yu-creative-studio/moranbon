// D1 とのやりとり
import {
  SLOTS, STAY_MIN, toMin, fromMin, coveredPoints, remainingFor, overlaps, dateRejection, slotPassed,
  addDays, tableTypeFor, newCode, canCancelOnline, isValidDate, phoneTimeError, MIN_PARTY, MAX_PARTY,
} from './rules.js';

const SETTING_DEFAULTS = { web_cap_4: 2, web_cap_6: 1, max_days_ahead: 0 };

export async function getSettings(db) {
  const { results } = await db.prepare('SELECT key, value FROM settings').all();
  const out = { ...SETTING_DEFAULTS };
  for (const r of results) if (r.key in out) out[r.key] = Number(r.value) || 0;
  return out;
}

export async function saveSettings(db, patch) {
  const stmts = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in SETTING_DEFAULTS)) continue;
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n) || n < 0 || n > 365) throw new Error(`${k} の値が正しくありません`);
    stmts.push(db.prepare('INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value').bind(k, String(n)));
  }
  if (stmts.length) await db.batch(stmts);
  return getSettings(db);
}

// ---- 卓 ----
export async function listTables(db, { all = false } = {}) {
  const { results } = await db.prepare(`SELECT * FROM tables ${all ? '' : 'WHERE active = 1'} ORDER BY sort, id`).all();
  return results;
}

export async function saveTables(db, list) {
  if (!Array.isArray(list) || list.length > 40) throw new Error('卓の一覧が正しくありません');
  const stmts = list.map((t, i) => {
    const name = String(t.name || '').trim().slice(0, 20);
    const cap = Math.floor(Number(t.capacity));
    if (!name) throw new Error('卓の名前を入力してください');
    if (!(cap >= 1 && cap <= 60)) throw new Error(`「${name}」の人数が正しくありません`);
    const webOk = t.web_ok && (cap === 4 || cap === 6) ? 1 : 0; // ネットは4人卓・6人卓だけ
    const active = t.active === false || t.active === 0 ? 0 : 1;
    return t.id
      ? db.prepare('UPDATE tables SET name = ?2, capacity = ?3, web_ok = ?4, active = ?5, sort = ?6 WHERE id = ?1').bind(Number(t.id), name, cap, webOk, active, i + 1)
      : db.prepare('INSERT INTO tables (name, capacity, web_ok, active, sort) VALUES (?1, ?2, ?3, ?4, ?5)').bind(name, cap, webOk, active, i + 1);
  });
  if (stmts.length) await db.batch(stmts);
  return listTables(db, { all: true });
}

// ネット予約で使える卓のうち、[start, end) に空いている数
function freeWebTables(tables, dayBookings, type, start, end) {
  return tables.filter((t) => t.web_ok && t.capacity === type &&
    !dayBookings.some((b) => b.table_id === t.id && overlaps(b.start_min, b.end_min, start, end))).length;
}

// 期間内の空き状況。日付ごと・時間帯ごとに 4人卓／6人卓の残り数を返す
// 残り＝「ネットに出す卓数の残り」と「実際に空いている卓の数」の少ない方
export async function availability(db, from, to, now) {
  const settings = await getSettings(db);
  const [bk, cl, tb] = await db.batch([
    db.prepare(`SELECT date, start_min, end_min, table_type, table_id, source FROM bookings
                WHERE status = 'confirmed' AND date BETWEEN ?1 AND ?2`).bind(from, to),
    db.prepare('SELECT date, start_time, reason FROM closures WHERE date BETWEEN ?1 AND ?2').bind(from, to),
    db.prepare('SELECT id, capacity, web_ok FROM tables WHERE active = 1').bind(),
  ]);
  const tables = tb.results;
  const byDate = {};
  for (const b of bk.results) (byDate[b.date] ||= []).push(b);
  const closedAll = {}, closedSlots = {};
  for (const c of cl.results) {
    if (c.start_time == null) closedAll[c.date] = c.reason || '臨時休業';
    else (closedSlots[c.date] ||= new Set()).add(c.start_time);
  }

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const reject = dateRejection(d, now, settings.max_days_ahead) || (closedAll[d] ? closedAll[d] : null);
    if (reject) { days.push({ date: d, open: false, reason: reject, slots: [] }); continue; }
    const list = byDate[d] || [];
    const web = (type) => list.filter((b) => b.source === 'web' && b.table_type === type).map((b) => [b.start_min, b.end_min]);
    const slots = SLOTS.map((t) => {
      if (slotPassed(d, t, now) || closedSlots[d]?.has(t)) return { time: t, t4: 0, t6: 0 };
      const s = toMin(t), e = s + STAY_MIN;
      return {
        time: t,
        t4: Math.min(remainingFor(t, web(4), settings.web_cap_4), freeWebTables(tables, list, 4, s, e)),
        t6: Math.min(remainingFor(t, web(6), settings.web_cap_6), freeWebTables(tables, list, 6, s, e)),
      };
    });
    const open = slots.some((s) => s.t4 > 0 || s.t6 > 0);
    days.push({ date: d, open, reason: open ? null : '満席', slots });
  }
  return days;
}

// 卓 tid が [start, end) に空いているか（自分自身 selfId は除く）。SQL の一部として使う
const tableFree = (tid, date, start, end, selfId) => `NOT EXISTS (SELECT 1 FROM bookings o
    WHERE o.table_id = ${tid} AND o.date = ${date} AND o.status = 'confirmed'
      AND o.start_min < ${end} AND o.end_min > ${start}${selfId ? ` AND o.id <> ${selfId}` : ''})`;

// ネット予約の作成。空き確認・卓の割り当て・作成を1つの INSERT で行い、同時アクセスでも重ならないようにする
export async function createBooking(db, req, guest, now) {
  const { date, time } = req;
  const party = Number(req.party_size);
  if (!isValidDate(date)) return { error: '日付が正しくありません' };
  if (!SLOTS.includes(time)) return { error: 'ネット予約できる時間は 17:30〜19:30 です' };
  if (!Number.isInteger(party) || party < MIN_PARTY || party > MAX_PARTY) {
    return { error: '7名様以上はお電話でご予約ください' };
  }
  const settings = await getSettings(db);
  const dateErr = dateRejection(date, now, settings.max_days_ahead);
  if (dateErr) return { error: dateErr };
  if (slotPassed(date, time, now)) return { error: '当日のご予約は来店時刻の1時間前までです' };

  const type = tableTypeFor(party);
  const startMin = toMin(time);
  const pts = coveredPoints(startMin);
  const capKey = type === 4 ? 'web_cap_4' : 'web_cap_6';
  const busyAt = (n) => `(SELECT COUNT(*) FROM bookings
        WHERE date = ?2 AND source = 'web' AND table_type = ?5 AND status = 'confirmed'
          AND start_min <= ?${n} AND end_min > ?${n}) < x.cap`;

  const sql = `
    INSERT INTO bookings (code, source, date, start_time, start_min, end_min, party_size, table_type, table_id,
                          name_kana, phone, email, note, status, created_at)
    SELECT ?1, 'web', ?2, ?3, ?4, ?4 + ${STAY_MIN}, ?6, ?5, x.tid, ?7, ?8, ?9, ?10, 'confirmed', ?11
    FROM (SELECT
            (SELECT t.id FROM tables t
              WHERE t.active = 1 AND t.web_ok = 1 AND t.capacity = ?5
                AND ${tableFree('t.id', '?2', '?4', `?4 + ${STAY_MIN}`)}
              ORDER BY t.sort, t.id LIMIT 1) AS tid,
            COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = ?12), ${SETTING_DEFAULTS[capKey]}) AS cap
         ) AS x
    WHERE x.tid IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM closures WHERE date = ?2 AND (start_time IS NULL OR start_time = ?3))
      AND ${busyAt(13)} AND ${busyAt(14)} AND ${busyAt(15)} AND ${busyAt(16)}`;

  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    try {
      const res = await db.prepare(sql).bind(
        code, date, time, startMin, type, party,
        guest.name_kana, guest.phone, guest.email, guest.note,
        new Date(now.ms).toISOString(), capKey, ...pts,
      ).run();
      if (!res.meta || res.meta.changes !== 1) {
        const closed = await db.prepare('SELECT 1 AS x FROM closures WHERE date = ?1 AND (start_time IS NULL OR start_time = ?2)').bind(date, time).first();
        return { error: closed ? 'この日時はご予約を受け付けていません' : '申し訳ありません。この時間は満席になりました。別の時間をお選びください', full: true };
      }
      const booking = await db.prepare('SELECT * FROM bookings WHERE code = ?1').bind(code).first();
      return { booking };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e; // 予約番号の重複だけ再試行
    }
  }
  throw new Error('予約番号を作れませんでした');
}

// ---- 電話予約（管理画面の予約表から） ----
function phoneFields(input) {
  const name = String(input.name_kana ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const phone = String(input.phone ?? '').replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0)).replace(/[^0-9]/g, '').slice(0, 15);
  const note = String(input.note ?? '').trim().slice(0, 300);
  const party = Math.floor(Number(input.party_size));
  const start = Math.floor(Number(input.start_min));
  const end = Math.floor(Number(input.end_min));
  const tableId = Math.floor(Number(input.table_id));
  let error = phoneTimeError(start, end);
  if (!error && !name) error = 'お名前を入力してください';
  if (!error && !(party >= 1 && party <= 60)) error = '人数が正しくありません';
  if (!error && !(tableId > 0)) error = '卓を選んでください';
  return { error, v: { name, phone, note, party, start, end, tableId } };
}

export async function addPhoneBooking(db, input, now) {
  if (!isValidDate(input.date)) return { error: '日付が正しくありません' };
  const { error, v } = phoneFields(input);
  if (error) return { error };
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newCode();
    try {
      const res = await db.prepare(`
        INSERT INTO bookings (code, source, date, start_time, start_min, end_min, party_size, table_type, table_id,
                              name_kana, phone, email, note, status, created_at)
        SELECT ?1, 'phone', ?2, ?3, ?4, ?5, ?6, t.capacity, t.id, ?7, ?8, '', ?9, 'confirmed', ?10
        FROM tables t
        WHERE t.id = ?11 AND t.active = 1 AND ${tableFree('t.id', '?2', '?4', '?5')}`).bind(
        code, input.date, fromMin(v.start), v.start, v.end, v.party, v.name, v.phone, v.note,
        new Date(now.ms).toISOString(), v.tableId,
      ).run();
      if (res.meta.changes !== 1) return { error: 'その卓は、その時間にすでに予約が入っています', status: 409 };
      return { booking: await db.prepare('SELECT * FROM bookings WHERE code = ?1').bind(code).first() };
    } catch (e) {
      if (!/UNIQUE/i.test(String(e?.message))) throw e;
    }
  }
  throw new Error('予約番号を作れませんでした');
}

// 予約の移動・時間変更・内容の修正（ネット予約も電話予約も）。重なる場合は変更しない
export async function updateBooking(db, id, input) {
  const cur = await db.prepare('SELECT * FROM bookings WHERE id = ?1').bind(id).first();
  if (!cur) return { error: '予約が見つかりません', status: 404 };
  if (cur.status !== 'confirmed') return { error: 'キャンセル済みの予約は変更できません', status: 409 };
  const merged = {
    table_id: cur.table_id, start_min: cur.start_min, end_min: cur.end_min, party_size: cur.party_size,
    name_kana: cur.name_kana, phone: cur.phone, note: cur.note, ...input,
  };
  const { error, v } = phoneFields(merged);
  if (error) return { error };
  const res = await db.prepare(`
    UPDATE bookings SET table_id = ?2, start_min = ?3, end_min = ?4, start_time = ?5, party_size = ?6,
                        name_kana = ?7, phone = ?8, note = ?9
    WHERE id = ?1 AND status = 'confirmed'
      AND EXISTS (SELECT 1 FROM tables WHERE id = ?2 AND active = 1)
      AND ${tableFree('?2', 'bookings.date', '?3', '?4', '?1')}`).bind(
    id, v.tableId, v.start, v.end, fromMin(v.start), v.party, v.name, cur.source === 'web' ? cur.phone : v.phone, v.note,
  ).run();
  if (res.meta.changes !== 1) return { error: 'その卓は、その時間にすでに予約が入っています', status: 409 };
  return { booking: await db.prepare('SELECT * FROM bookings WHERE id = ?1').bind(id).first() };
}

// お客さんによるキャンセル（予約番号＋電話番号）
export async function guestCancel(db, code, phone, now) {
  const b = await db.prepare("SELECT * FROM bookings WHERE code = ?1 AND phone = ?2 AND source = 'web'").bind(code, phone).first();
  if (!b) return { error: '予約が見つかりません。予約番号と電話番号をご確認ください', status: 404 };
  if (b.status === 'canceled') return { error: 'このご予約はすでにキャンセルされています', status: 409, booking: b };
  if (!canCancelOnline(b.date, now)) {
    return { error: '当日のキャンセルはお電話（0268-22-4129）でお願いいたします', status: 409, booking: b };
  }
  return cancelById(db, b.id, 'guest', now);
}

export async function cancelById(db, id, by, now) {
  const res = await db.prepare(`UPDATE bookings SET status = 'canceled', canceled_at = ?2, canceled_by = ?3
                                WHERE id = ?1 AND status = 'confirmed'`).bind(id, new Date(now.ms).toISOString(), by).run();
  const b = await db.prepare('SELECT * FROM bookings WHERE id = ?1').bind(id).first();
  if (!b) return { error: '予約が見つかりません', status: 404 };
  if (res.meta.changes !== 1) return { error: 'このご予約はすでにキャンセルされています', status: 409, booking: b };
  return { booking: b };
}

export async function bookingsOn(db, date) {
  const { results } = await db.prepare('SELECT * FROM bookings WHERE date = ?1 ORDER BY start_min, id').bind(date).all();
  return results;
}

// ---- 臨時休業・貸切 ----
export async function listClosures(db, fromDate) {
  const { results } = await db.prepare('SELECT * FROM closures WHERE date >= ?1 ORDER BY date, start_time').bind(fromDate).all();
  return results;
}
export async function addClosure(db, date, startTime, reason, now) {
  if (!isValidDate(date)) throw new Error('日付が正しくありません');
  if (startTime != null && !SLOTS.includes(startTime)) throw new Error('時間帯が正しくありません');
  await db.prepare('INSERT INTO closures (date, start_time, reason, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(date, startTime, String(reason || '').slice(0, 60), new Date(now.ms).toISOString()).run();
}
export async function deleteClosure(db, id) {
  await db.prepare('DELETE FROM closures WHERE id = ?1').bind(id).run();
}

// ---- 前日リマインド（メールアドレスのあるネット予約だけ） ----
export async function reminderTargets(db, date) {
  const { results } = await db.prepare(`SELECT * FROM bookings WHERE date = ?1 AND status = 'confirmed' AND reminder_sent = 0
                                          AND source = 'web' AND email <> '' ORDER BY start_min`).bind(date).all();
  return results;
}
export async function markReminded(db, ids) {
  const stmts = ids.filter(Number.isInteger).map((id) => db.prepare('UPDATE bookings SET reminder_sent = 1 WHERE id = ?1').bind(id));
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// 予約データの保存期間：来店日から365日を過ぎたものを削除
export async function purgeOld(db, now, keepDays = 365) {
  const cutoff = addDays(now.date, -keepDays);
  const res = await db.prepare('DELETE FROM bookings WHERE date < ?1').bind(cutoff).run();
  await db.prepare('DELETE FROM closures WHERE date < ?1').bind(cutoff).run();
  return res.meta.changes;
}
