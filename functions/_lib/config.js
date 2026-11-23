// shop.config.js を読み込み、間違いがないか確かめて、画面・ルール・メールで使う形にする
import raw from '../shop.config.js';

const WEEKDAYS = '日月火水木金土';
const isHm = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
export const toMin = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };
export const fromMin = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const durationJa = (min) => {
  const h = Math.floor(min / 60), m = min % 60;
  return [h ? `${h}時間` : '', m ? `${m}分` : ''].join('') || '0分';
};

function weekdayIndex(w) {
  if (Number.isInteger(w) && w >= 0 && w <= 6) return w;
  const i = WEEKDAYS.indexOf(String(w ?? '').charAt(0));
  return i >= 0 && String(w).replace(/曜日?$/, '').length === 1 ? i : -1;
}

// 設定の間違いを日本語のリストで返す（空なら問題なし）
export function checkConfig(c) {
  const e = [];
  const req = (v, name) => { if (typeof v !== 'string' || !v.trim()) e.push(`${name} を入力してください`); };
  req(c?.shop?.name, 'shop.name（店名）');
  req(c?.shop?.tel, 'shop.tel（電話番号）');
  req(c?.shop?.address, 'shop.address（住所）');
  req(c?.shop?.siteUrl, 'shop.siteUrl（サイトURL）');
  if (c?.shop?.siteUrl && !/^https:\/\/[^/]+(\/.*[^/])?$/.test(c.shop.siteUrl)) e.push('shop.siteUrl は https:// で始め、最後に / をつけないでください');
  if (c?.shop?.tel && !/^0\d{1,4}-?\d{1,4}-?\d{3,4}$/.test(c.shop.tel)) e.push('shop.tel は 0268-22-4129 のような形で書いてください');

  const h = c?.hours || {};
  const step = h.step;
  const before = e.length;
  if (!isHm(h.open) || !isHm(h.close)) e.push('hours.open / hours.close は "17:30" のように書いてください');
  if (![15, 30, 60].includes(step)) e.push('hours.step は 15・30・60 のどれかにしてください');
  const ok = e.length === before;
  const open = ok ? toMin(h.open) : 0, close = ok ? toMin(h.close) : 0;
  if (ok) {
    if (close <= open) e.push('hours.close は hours.open より後にしてください（深夜営業には未対応）');
    if ((open % step) || (close % step)) e.push(`営業時間は ${step}分刻みにしてください`);
  }

  const w = c?.web || {};
  if (!Array.isArray(w.slots) || !w.slots.length) e.push('web.slots に来店時刻を1つ以上入れてください');
  else {
    if (w.slots.some((s) => !isHm(s))) e.push('web.slots の時刻は "17:30" のように書いてください');
    else {
      const mins = w.slots.map(toMin);
      if (mins.some((m, i) => i > 0 && m <= mins[i - 1])) e.push('web.slots は早い順に、重ならないように並べてください');
      if (ok && mins.some((m) => (m - open) % step)) e.push(`web.slots は営業時間に合わせて ${step}分刻みにしてください`);
      if (ok && mins.some((m) => m < open)) e.push('web.slots に開店前の時刻が入っています');
      if (ok && Number.isInteger(w.stayMinutes) && mins.some((m) => m + w.stayMinutes > close)) {
        e.push(`web.slots の最後（${w.slots.at(-1)}）＋滞在時間が閉店（${h.close}）を超えています`);
      }
    }
  }
  if (!Number.isInteger(w.stayMinutes) || w.stayMinutes <= 0 || (step && w.stayMinutes % step)) {
    e.push(`web.stayMinutes は ${step || 30}分の倍数にしてください`);
  } else if (step && w.stayMinutes / step > 48) {
    e.push('web.stayMinutes が長すぎます（マス48個分まで）');
  }
  if (!Number.isInteger(w.sameDayDeadlineMinutes) || w.sameDayDeadlineMinutes < 0 || w.sameDayDeadlineMinutes > 24 * 60) {
    e.push('web.sameDayDeadlineMinutes は 0 以上の分数にしてください');
  }
  if (!Number.isInteger(w.cancelDaysBefore) || w.cancelDaysBefore < 0 || w.cancelDaysBefore > 30) {
    e.push('web.cancelDaysBefore は 0〜30 の整数にしてください');
  }
  if (!Number.isInteger(w.maxParty) || w.maxParty < 1 || w.maxParty > 6) {
    e.push('web.maxParty は 1〜6 にしてください（ネット予約は4人卓・6人卓のみ対応）');
  }
  if (w.phoneOnly != null && !Array.isArray(w.phoneOnly)) e.push('web.phoneOnly は [ ] で囲んだリストにしてください');

  if (!Array.isArray(c?.closedDays)) e.push('closedDays は [ ] で囲んだリストにしてください（定休日なしなら []）');
  else c.closedDays.forEach((d, i) => {
    if (weekdayIndex(d?.weekday) < 0) e.push(`closedDays の ${i + 1}つ目：weekday は '月' のように曜日を1文字で書いてください`);
    if (d?.nth != null && !([1, 2, 3, 4, 5, -1].includes(d.nth))) e.push(`closedDays の ${i + 1}つ目：nth は 1〜5 か -1（最終）にしてください`);
  });

  if (!Number.isInteger(c?.dataRetentionDays) || c.dataRetentionDays < 30) e.push('dataRetentionDays は 30 以上の日数にしてください');

  const m = c?.mail || {};
  for (const k of ['booked', 'canceled', 'reminder']) {
    req(m[k]?.subject, `mail.${k}.subject（件名）`);
    req(m[k]?.body, `mail.${k}.body（本文）`);
  }
  req(m.fromName, 'mail.fromName');
  req(c?.privacy?.businessName, 'privacy.businessName（事業者名）');
  return e;
}

const errors = checkConfig(raw);
if (errors.length) throw new Error('shop.config.js の設定に間違いがあります：\n- ' + errors.join('\n- '));

// ---- ここから下は、設定から計算した値 ----
const c = raw;
export const config = c;
export const OPEN_MIN = toMin(c.hours.open);
export const CLOSE_MIN = toMin(c.hours.close);
export const GRID_STEP = c.hours.step;
export const SLOTS = [...c.web.slots];
export const STAY_MIN = c.web.stayMinutes;
export const SAME_DAY_LEAD_MIN = c.web.sameDayDeadlineMinutes;
export const CANCEL_DAYS_BEFORE = c.web.cancelDaysBefore;
export const MIN_PARTY = 1;
export const MAX_PARTY = c.web.maxParty;
export const RETENTION_DAYS = c.dataRetentionDays;

export const CLOSED_DAYS = c.closedDays.map((d) => ({ dow: weekdayIndex(d.weekday), nth: d.nth ?? null }));
const closedLabel = ({ dow, nth }) =>
  nth == null ? `毎週${WEEKDAYS[dow]}曜日` : nth === -1 ? `最終${WEEKDAYS[dow]}曜日` : `第${nth}${WEEKDAYS[dow]}曜日`;
export const closedDayLabel = closedLabel;

// 画面・メールで使う文章
const lastSlot = toMin(SLOTS.at(-1));
const phoneFrom = lastSlot + GRID_STEP < CLOSE_MIN ? `${fromMin(lastSlot + GRID_STEP)}以降のご来店` : '';
const sameDayText = SAME_DAY_LEAD_MIN === 0 ? 'ご来店時刻まで' : `ご来店の${durationJa(SAME_DAY_LEAD_MIN)}前まで`;
export const texts = {
  stay: `${durationJa(STAY_MIN)}制`,                                           // 2時間制
  slotsRange: SLOTS.length > 1 ? `${SLOTS[0]}〜${SLOTS.at(-1)}` : SLOTS[0],       // 17:30〜19:30
  sameDay: sameDayText,                                                          // ご来店の1時間前まで
  cancelDeadline: CANCEL_DAYS_BEFORE === 0 ? sameDayText
    : CANCEL_DAYS_BEFORE === 1 ? 'ご来店日の前日 23:59 まで' : `ご来店日の${CANCEL_DAYS_BEFORE}日前 23:59 まで`,
  cancelAfter: CANCEL_DAYS_BEFORE === 0 ? 'それ以降' : CANCEL_DAYS_BEFORE === 1 ? '当日' : '期限を過ぎてから',
  overParty: `${MAX_PARTY + 1}名様以上`,                                         // 7名様以上
  phoneOnly: [`${MAX_PARTY + 1}名様以上`, ...(c.web.phoneOnly || []), phoneFrom].filter(Boolean).join('・'),
  closedDays: CLOSED_DAYS.length ? CLOSED_DAYS.map(closedLabel).join('・') : 'なし',
  hours: `${c.hours.open}〜${c.hours.close}`,
};
texts.hoursLine = `営業時間 ${texts.hours}／定休日 ${texts.closedDays}${c.closedDaysNote ? `（${c.closedDaysNote}）` : ''}`;

// 画面に渡してよい情報だけ（/api/config）
export const publicConfig = {
  shop: { ...c.shop, telHref: c.shop.tel.replace(/[^0-9+]/g, '') },
  brand: c.brand || {},
  hours: { open: c.hours.open, close: c.hours.close, step: GRID_STEP, openMin: OPEN_MIN, closeMin: CLOSE_MIN },
  web: { slots: SLOTS, stayMinutes: STAY_MIN, maxParty: MAX_PARTY, sameDayDeadlineMinutes: SAME_DAY_LEAD_MIN, cancelDaysBefore: CANCEL_DAYS_BEFORE },
  texts,
  privacy: { ...c.privacy, extraPurposes: c.privacy.extraPurposes || [], retentionDays: RETENTION_DAYS },
};

// {キー} を置き換える
export const fillTemplate = (tpl, vars) =>
  String(tpl).replace(/\{([^{}]+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));
