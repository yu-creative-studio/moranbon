// メールの件名・本文を組み立てる（文面は functions/shop.config.js の mail）。
// 送信は Apps Script（お店の Gmail）が行う。Apps Script 側にはお店ごとの文面を置かない。
import { config, texts, fillTemplate } from './config.js';

const WD = '日月火水木金土';
const dateJa = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return `${m}月${d}日（${WD[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]}）`;
};

export function bookingDetails(b) {
  return [
    `予約番号：${b.code}`,
    `日時　　：${dateJa(b.date)} ${b.start_time}〜`,
    `人数　　：${b.party_size}名様`,
    `お名前　：${b.name_kana} 様`,
  ].join('\n');
}

function vars(b, site) {
  return {
    店名: config.shop.name,
    電話番号: config.shop.tel,
    住所: config.shop.address,
    サイトURL: config.shop.siteUrl,
    お名前: b.name_kana,
    予約内容: bookingDetails(b),
    キャンセルURL: `${site}/reserve/cancel/?code=${b.code}`,
    予約ページURL: `${site}/reserve/`,
    キャンセル期限: texts.cancelDeadline,
    滞在時間: texts.stay,
    営業案内: texts.hoursLine,
  };
}

// お客さん宛（booked / canceled / reminder）
export function guestMessage(kind, b, site = config.shop.siteUrl) {
  if (!b.email) return null; // 電話予約などメールのない予約
  const tpl = config.mail[kind];
  const v = vars(b, site);
  const body = fillTemplate(tpl.body, v).trim();
  const sig = config.mail.signature ? `\n\n${fillTemplate(config.mail.signature, v).trim()}` : '';
  return { to: b.email, subject: fillTemplate(tpl.subject, v), body: body + sig, fromName: config.mail.fromName };
}

// お店宛の通知（文面は共通）。to: 'shop' は Apps Script 側で通知先アドレスに置き換える
export function shopMessage(kind, b, site = config.shop.siteUrl) {
  const head = kind === 'booked' ? 'ネット予約' : 'キャンセル';
  const lead = kind === 'booked' ? '新しいネット予約が入りました。' : 'ネット予約がキャンセルされました。';
  return {
    to: 'shop',
    subject: `【${head}】${dateJa(b.date)} ${b.start_time} ${b.party_size}名 ${b.name_kana}様`,
    body: [
      lead, '',
      bookingDetails(b),
      `電話番号：${b.phone}`,
      `メール　：${b.email}`,
      `ご要望　：${b.note || 'なし'}`,
      `卓　　　：${b.table_type}人卓`,
      '',
      `管理画面：${site}/admin/`,
    ].join('\n'),
    fromName: config.mail.shopFromName || `${config.shop.name} ネット予約`,
  };
}

// 予約・キャンセルのたびに送るメール。お客さん宛を先に（送信数の上限に近いときも、お客さんへの連絡を優先）
export function messagesFor(type, b, site) {
  const out = [];
  if (type === 'booked') out.push(guestMessage('booked', b, site), shopMessage('booked', b, site));
  if (type === 'canceled') {
    out.push(guestMessage('canceled', b, site));
    if (b.canceled_by !== 'admin') out.push(shopMessage('canceled', b, site)); // お店が取り消したときは、お店には送らない
  }
  return out.filter(Boolean);
}
