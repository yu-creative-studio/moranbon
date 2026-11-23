// 予約ルール（純粋な計算だけ。DBには触らない）
// 時刻はすべて日本時間で判定する。Workers の実行環境は UTC なので、
// Date の値に +9時間してから UTC の getter で読む。

export const SLOTS = ['17:30', '18:00', '18:30', '19:00', '19:30'];
export const STAY_MIN = 120;          // 1組2時間制
export const SAME_DAY_LEAD_MIN = 60;  // 当日は来店1時間前まで
export const MIN_PARTY = 1;
export const MAX_PARTY = 6;           // 7名以上は電話
export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

export const toMin = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

// 新しい予約 [t, t+120) と重なる時点。開始時刻が30分刻みなので、この4点を見れば十分
export const coveredPoints = (startMin) => [0, 30, 60, 90].map((d) => startMin + d);

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

// 定休日：毎週月曜日、第2火曜日（8〜14日の火曜）
export function regularHoliday(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay();
  const day = d.getUTCDate();
  if (dow === 1) return '定休日（月曜日）';
  if (dow === 2 && day >= 8 && day <= 14) return '定休日（第2火曜日）';
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

// その時刻がもう締め切りか（当日は来店1時間前まで）
export function slotPassed(dateStr, slot, now) {
  if (dateStr > now.date) return false;
  if (dateStr < now.date) return true;
  return now.minutes + SAME_DAY_LEAD_MIN > toMin(slot);
}

// キャンセル期限：来店日の前日 23:59（日本時間）まで
export const canCancelOnline = (dateStr, now) => now.date < dateStr;

// 予約済みの開始時刻（分）の配列から、時刻 slot に入れる残り卓数を出す
export function remainingFor(slot, startMins, cap) {
  let worst = 0;
  for (const p of coveredPoints(toMin(slot))) {
    const n = startMins.filter((s) => s <= p && p < s + STAY_MIN).length;
    if (n > worst) worst = n;
  }
  return Math.max(0, cap - worst);
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
