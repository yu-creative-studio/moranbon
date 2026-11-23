/**
 * MORANBON ネット予約 — メール送信（Google Apps Script）
 *
 * お店の Google アカウントで script.google.com を開き、新しいプロジェクトにこのファイルを貼り付ける。
 * 設定（プロジェクトの設定 → スクリプト プロパティ）：
 *   GAS_SECRET   … Cloudflare の環境変数 GAS_SECRET と同じ値（24文字以上のランダムな文字列）
 *   SITE_URL     … https://moranbong-yakiniku.com
 *   SHOP_EMAIL   … 予約通知を受け取るアドレス（省略時はこのスクリプトの持ち主）
 * デプロイ：「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *   次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *   → 表示された URL（…/exec）を Cloudflare の環境変数 GAS_WEBHOOK_URL に入れる
 * 前日リマインド：setupTrigger を一度だけ実行する（毎日 10時台に sendReminders が動く）
 */

const SHOP = {
  name: '焼肉 モランボン',
  tel: '0268-22-4129',
  address: '長野県上田市中央2-13-10',
  hours: '17:30〜21:30（定休日 毎週月曜日・第2火曜日）',
};

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// ---------- Cloudflare から呼ばれる（予約・キャンセルのたび） ----------
function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  if (!data || data.secret !== prop_('GAS_SECRET')) return out_({ ok: false, error: 'forbidden' });

  const b = data.booking;
  if (data.type === 'booked') {
    mailGuest_(b.email, '【焼肉 モランボン】ご予約を承りました', bookedBody_(b));
    mailShop_(`【ネット予約】${dateJa_(b.date)} ${b.start_time} ${b.party_size}名 ${b.name_kana}様`, shopBody_('新しいネット予約が入りました。', b));
  } else if (data.type === 'canceled') {
    mailGuest_(b.email, '【焼肉 モランボン】ご予約のキャンセルを承りました', canceledBody_(b));
    if (b.canceled_by !== 'admin') {
      mailShop_(`【キャンセル】${dateJa_(b.date)} ${b.start_time} ${b.party_size}名 ${b.name_kana}様`, shopBody_('ネット予約がキャンセルされました。', b));
    }
  }
  return out_({ ok: true });
}

// ---------- 前日リマインド（毎日1回） ----------
function sendReminders() {
  const site = prop_('SITE_URL');
  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  const headers = { 'X-Moranbon-Secret': prop_('GAS_SECRET') };
  const res = UrlFetchApp.fetch(`${site}/api/internal/reminders?date=${tomorrow}`, { headers, muteHttpExceptions: true });
  const body = JSON.parse(res.getContentText() || '{}');
  if (!body.ok) throw new Error('リマインド対象を取得できませんでした: ' + res.getContentText());

  const sent = [];
  body.bookings.forEach((b) => {
    try {
      mailGuest_(b.email, '【焼肉 モランボン】明日のご予約のお知らせ', reminderBody_(b));
      sent.push(b.id);
    } catch (err) { console.error(err); }
  });
  // 送信済みにする。あわせて来店日から1年を過ぎた予約データを削除
  UrlFetchApp.fetch(`${site}/api/internal/reminders`, {
    method: 'post', contentType: 'application/json', headers, muteHttpExceptions: true,
    payload: JSON.stringify({ ids: sent, purge: true }),
  });
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === 'sendReminders').forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(10).inTimezone('Asia/Tokyo').create();
}

// ---------- 本文 ----------
function bookedBody_(b) {
  return [
    `${b.name_kana} 様`,
    '',
    `このたびは${SHOP.name}をご予約いただき、ありがとうございます。`,
    '以下の内容でご予約を承りました。',
    '',
    details_(b),
    '',
    '■ キャンセルについて',
    'ご来店日の前日 23:59 まで、下記のページからキャンセルできます（予約番号と電話番号が必要です）。',
    `${prop_('SITE_URL')}/reserve/cancel/?code=${b.code}`,
    `当日のキャンセル・人数や時間の変更は、お電話（${SHOP.tel}）でお願いいたします。`,
    '',
    'お席は2時間制です。ご来店を心よりお待ちしております。',
    footer_(),
  ].join('\n');
}
function canceledBody_(b) {
  return [
    `${b.name_kana} 様`,
    '',
    '以下のご予約のキャンセルを承りました。',
    '',
    details_(b),
    '',
    'またのご来店を心よりお待ちしております。',
    `${prop_('SITE_URL')}/reserve/`,
    footer_(),
  ].join('\n');
}
function reminderBody_(b) {
  return [
    `${b.name_kana} 様`,
    '',
    `明日のご予約のお知らせです。${SHOP.name}でお待ちしております。`,
    '',
    details_(b),
    '',
    `ご都合が悪くなった場合は、お手数ですがお電話（${SHOP.tel}）でご連絡ください。`,
    footer_(),
  ].join('\n');
}
function shopBody_(lead, b) {
  return [
    lead,
    '',
    details_(b),
    `電話番号：${b.phone}`,
    `メール　：${b.email}`,
    `ご要望　：${b.note || 'なし'}`,
    `卓　　　：${b.table_type}人卓`,
    '',
    `管理画面：${prop_('SITE_URL')}/admin/`,
  ].join('\n');
}
function details_(b) {
  return [
    `予約番号：${b.code}`,
    `日時　　：${dateJa_(b.date)} ${b.start_time}〜`,
    `人数　　：${b.party_size}名様`,
    `お名前　：${b.name_kana} 様`,
  ].join('\n');
}
function footer_() {
  return ['', '――――――――――――――――', SHOP.name, SHOP.address, `TEL ${SHOP.tel}`, SHOP.hours, prop_('SITE_URL'),
    '※このメールは送信専用です。お問い合わせはお電話でお願いいたします。'].join('\n');
}

// ---------- 共通 ----------
function mailGuest_(to, subject, body) {
  if (!to) return;
  GmailApp.sendEmail(to, subject, body, { name: SHOP.name, noReply: false });
}
function mailShop_(subject, body) {
  const to = prop_('SHOP_EMAIL') || Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(to, subject, body, { name: 'モランボン ネット予約' });
}
function dateJa_(s) {
  const p = s.split('-').map(Number);
  const w = '日月火水木金土'[new Date(Date.UTC(p[0], p[1] - 1, p[2])).getUTCDay()];
  return `${p[1]}月${p[2]}日（${w}）`;
}
function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
