// 予約ルール（純粋な計算だけ。DBには触らない）
// お店ごとに変わる値は functions/shop.config.js にあり、_lib/config.js 経由で読む。
// 時刻はすべて日本時間で判定する。Workers の実行環境は UTC なので、
// Date の値に +9時間してから UTC の getter で読む。
import {
  SLOTS, STAY_MIN, SAME_DAY_LEAD_MIN, CANCEL_DAYS_BEFORE, MIN_PARTY, MAX_PARTY,
  OPEN_MIN, CLOSE_MIN, GRID_STEP, CLOSED_DAYS, closedDayLabel, toMin, fromMin, config,
} from './config.js';

export { SLOTS, STAY_MIN, SAME_DAY_LEAD_MIN, MIN_PARTY, MAX_PARTY, OPEN_MIN, CLOSE_MIN, GRID_STEP, toMin, fromMin };
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// 新しい予約 [t, t+滞在時間) と重なる時点。予約はすべてマスの刻みに乗っているので、刻みごとに見れば十分
export const coveredPoints = (startMin, stay = STAY_MIN) => {
  const out = [];
  for (let d = 0; d < stay; d += GRID_STEP) out.push(startMin + d);
  return out;
};

export const tableTypeFor = (party) => (party <= 4 ? 4 : 6);

// 日本時間の「今」
export function nowJst(nowMs = Date.now()) {
  const d = new Date(nowMs + JST_OFFSET_MS);
  const date = d.toISOString().slice(0, 10);
  const minutes = d.getUTCHours() * 60 + d.getUTCMinutes();
  return { date, minutes, ms: nowMs };
}

export const isValidDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

export const addDays = (dateStr, n) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

export const daysBetween = (a, b) =>
  Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);

// 定休日（shop.config.js の closedDays）。第n◯曜日は「(n-1)*7+1 〜 n*7 日の◯曜日」、最終は「あと7日で月が変わる◯曜日」
export function regularHoliday(dateStr, rules = CLOSED_DAYS) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const day = d.getUTCDate();
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  for (const r of rules) {
    if (r.dow !== dow) continue;
    if (r.nth == null) return `定休日（${closedDayLabel(r).replace(/^毎週/, '')}）`;
    if (r.nth === -1 ? day + 7 > last : day > (r.nth - 1) * 7 && day <= r.nth * 7) return `定休日（${closedDayLabel(r)}）`;
  }
  return null;
}

// 日付として受け付けられるか（定休日・過去・上限日数）。臨時休業は別で見る
export function dateRejection(dateStr, now, maxDaysAhead) {
  if (!isValidDate(dateStr)) return '日付が正しくありません';
  if (dateStr < now.date) return '過去の日付は選べません';
  if (maxDaysAhead > 0 && daysBetween(now.date, dateStr) > maxDaysAhead) {
    return `${maxDaysAhead}日先までのご予約を受け付けています`;
  }
  return regularHoliday(dateStr);
}

// その時刻がもう締め切りか（当日は来店◯分前まで）
export function slotPassed(dateStr, slot, now) {
  if (dateStr > now.date) return false;
  if (dateStr < now.date) return true;
  return now.minutes + SAME_DAY_LEAD_MIN > toMin(slot);
}

// ネットでキャンセルできるか。cancelDaysBefore：1＝前日23:59まで、2＝2日前まで、0＝当日の締め切り時刻まで
export function canCancelOnline(dateStr, startTime, now, daysBefore = CANCEL_DAYS_BEFORE) {
  if (daysBefore === 0) return !slotPassed(dateStr, startTime, now);
  return daysBetween(now.date, dateStr) >= daysBefore;
}

// 予約済みの [開始, 終了) の配列から、時刻 slot に入れる残り数を出す（同時に使っている数で判定）
export function remainingFor(slot, intervals, cap) {
  let worst = 0;
  for (const p of coveredPoints(toMin(slot))) {
    const n = intervals.filter(([s, e]) => s <= p && p < e).length;
    if (n > worst) worst = n;
  }
  return Math.max(0, cap - worst);
}

// [a1, a2) と [b1, b2) が重なるか
export const overlaps = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

// ---- 予約表（電話予約の手入力） ----
// 電話予約の時間チェック：開店〜閉店の間、マスの刻み
export function phoneTimeError(startMin, endMin) {
  if (!Number.isInteger(startMin) || !Number.isInteger(endMin)) return '時間が正しくありません';
  if (startMin % GRID_STEP || endMin % GRID_STEP) return `時間は${GRID_STEP}分刻みで入力してください`;
  if (startMin < OPEN_MIN || startMin >= CLOSE_MIN) {
    return `開始は ${config.hours.open}〜${fromMin(CLOSE_MIN - GRID_STEP)} の間で入力してください`;
  }
  if (endMin <= startMin) return '終了は開始より後にしてください';
  if (endMin > CLOSE_MIN) return `終了は閉店（${config.hours.close}）までにしてください`;
  return null;
}

// ---- 入力の検証（サーバー側でも必ず行う） ----
export const normalizePhone = (s) =>
  String(s ?? '')
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[^0-9]/g, '');

export function validateGuest(input) {
  const errors = {};
  const name = String(input.name_kana ?? '')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60)) // ひらがな→カタカナ
    .replace(/\s+/g, ' ')
    .trim();
  if (!name) errors.name_kana = 'お名前（カナ）を入力してください';
  else if (!/^[ァ-ヶー・ 　]+$/.test(name)) errors.name_kana = 'カタカナで入力してください';
  else if (name.length > 40) errors.name_kana = '40文字以内で入力してください';

  const phone = normalizePhone(input.phone);
  if (!/^0\d{9,10}$/.test(phone)) errors.phone = '電話番号を正しく入力してください（例：090-1234-5678）';

  const email = String(input.email ?? '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 200) {
    errors.email = 'メールアドレスを正しく入力してください';
  }

  const note = String(input.note ?? '').trim();
  if (note.length > 300) errors.note = 'ご要望は300文字以内で入力してください';

  return { ok: Object.keys(errors).length === 0, errors, value: { name_kana: name, phone, email, note } };
}

// 予約番号：紛らわしい文字（0 O 1 I L）を除いた英数8桁
const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newCode() {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
}

export const formatDateJa = (dateStr) => {
  const d = new Date(dateStr + 'T00:00:00Z');
  const w = '日月火水木金土'[d.getUTCDay()];
  return `${d.getUTCFullYear()}年${d.getUTCMonth() + 1}月${d.getUTCDate()}日（${w}）`;
};
