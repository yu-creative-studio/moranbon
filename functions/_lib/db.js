// D1 とのやりとり
import {
  SLOTS, STAY_MIN, toMin, coveredPoints, remainingFor, dateRejection, slotPassed,
  addDays, tableTypeFor, newCode, canCancelOnline, isValidDate, MIN_PARTY, MAX_PARTY,
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

// 期間内の空き状況。日付ごと・時間帯ごとに 4人卓／6人卓の残り数を返す
export async function availability(db, from, to, now) {
  const settings = await getSettings(db);
  const [bk, cl] = await db.batch([
    db.prepare(`SELECT date, start_min, table_type FROM bookings
                WHERE status = 'confirmed' AND date BETWEEN ?1 AND ?2`).bind(from, to),
    db.prepare('SELECT date, start_time, reason FROM closures WHERE date BETWEEN ?1 AND ?2').bind(from, to),
  ]);
  const byDate = {};
  for (const b of bk.results) {
    const k = `${b.date}|${b.table_type}`;
    (byDate[k] ||= []).push(b.start_min);
  }
  const closedAll = {}, closedSlots = {};
  for (const c of cl.results) {
    if (c.start_time == null) closedAll[c.date] = c.reason || '臨時休業';
    else (closedSlots[c.date] ||= new Set()).add(c.start_time);
  }

  const days = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const reject = dateRejection(d, now, settings.max_days_ahead) || (closedAll[d] ? closedAll[d] : null);
    if (reject) { days.push({ date: d, open: false, reason: reject, slots: [] }); continue; }
    const slots = SLOTS.map((t) => {
      if (slotPassed(d, t, now) || closedSlots[d]?.has(t)) return { time: t, t4: 0, t6: 0 };
      return {
        time: t,
        t4: remainingFor(t, byDate[`${d}|4`] || [], settings.web_cap_4),
        t6: remainingFor(t, byDate[`${d}|6`] || [], settings.web_cap_6),
      };
    });
    const open = slots.some((s) => s.t4 > 0 || s.t6 > 0);
    days.push({ date: d, open, reason: open ? null : '満席', slots });
  }
  return days;
}

// 予約作成。空き確認と作成を1つの INSERT で行い、同時アクセスでも上限を超えないようにする
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
  const capDefault = SETTING_DEFAULTS[capKey];
  const busyAt = (n) => `(SELECT COUNT(*) FROM bookings
        WHERE date = ?2 AND table_type = ?5 AND status = 'confirmed'
          AND start_min <= ?${n} AND start_min + ${STAY_MIN} > ?${n}) < cap.v`;

  const sql = `
    INSERT INTO bookings (code, date, start_time, start_min, party_size, table_type,
                          name_kana, phone, email, note, status, created_at)
    SELECT ?1, ?2, ?3, ?4, ?6, ?5, ?7, ?8, ?9, ?10, 'confirmed', ?11
    FROM (SELECT COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = ?12), ${capDefault}) AS v) AS cap
    WHERE NOT EXISTS (SELECT 1 FROM closures WHERE date = ?2 AND (start_time IS NULL OR start_time = ?3))
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

// お客さんによるキャンセル（予約番号＋電話番号）
export async function guestCancel(db, code, phone, now) {
  const b = await db.prepare('SELECT * FROM bookings WHERE code = ?1 AND phone = ?2').bind(code, phone).first();
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

// ---- 前日リマインド ----
export async function reminderTargets(db, date) {
  const { results } = await db.prepare(`SELECT * FROM bookings WHERE date = ?1 AND status = 'confirmed' AND reminder_sent = 0
                                        ORDER BY start_min`).bind(date).all();
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
