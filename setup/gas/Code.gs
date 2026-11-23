/**
 * ネット予約 — メール送信（Google Apps Script）  テンプレート版 v2
 *
 * このファイルはどのお店でも同じ。店名やメールの文面は Cloudflare 側の
 * functions/shop.config.js にあり、件名・本文ができあがった状態で届く。
 *
 * お店の Google アカウントで script.google.com を開き、新しいプロジェクトにこのファイルを貼り付ける。
 * 設定（プロジェクトの設定 → スクリプト プロパティ）：
 *   GAS_SECRET   … Cloudflare の環境変数 GAS_SECRET と同じ値（24文字以上のランダムな文字列）
 *   SITE_URL     … お店のサイトの URL（例：https://moranbong-yakiniku.com）。最後の / はつけない
 *   SHOP_EMAIL   … 予約通知を受け取るアドレス（省略時はこのスクリプトの持ち主）
 * デプロイ：「デプロイ」→「新しいデプロイ」→ 種類「ウェブアプリ」
 *   次のユーザーとして実行：自分 ／ アクセスできるユーザー：全員
 *   → 表示された URL（…/exec）を Cloudflare の環境変数 GAS_WEBHOOK_URL に入れる
 * 前日リマインド：setupTrigger を一度だけ実行する（毎日 10時台に sendReminders が動く）
 *
 * 送信数の上限：無料の Gmail は 1日 100通ほど（Google Workspace は 1,500通ほど）。
 *   ・前日リマインドは、新しい予約の確認メール用に RESERVE 通を残して送る
 *   ・送れなかったメールは記録し、次の前日リマインドのときにお店へまとめて知らせる
 */

const RESERVE = 20; // 前日リマインドのときに残しておく送信数

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key) || '';
}

// ---------- Cloudflare から呼ばれる（予約・キャンセルのたび） ----------
function doPost(e) {
  let data;
  try { data = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  if (!data || !prop_('GAS_SECRET') || data.secret !== prop_('GAS_SECRET')) return out_({ ok: false, error: 'forbidden' });
  if (!Array.isArray(data.messages)) return out_({ ok: false, error: 'Cloudflare 側が古い版です（messages がありません）' });

  const results = data.messages.map(function (m) { return send_(m); });
  return out_({ ok: true, sent: results.filter(Boolean).length });
}

// ---------- 前日リマインド（毎日1回） ----------
function sendReminders() {
  const site = prop_('SITE_URL');
  const headers = { 'X-Reserve-Secret': prop_('GAS_SECRET') };
  reportFailures_();

  const tomorrow = Utilities.formatDate(new Date(Date.now() + 86400000), 'Asia/Tokyo', 'yyyy-MM-dd');
  const res = UrlFetchApp.fetch(site + '/api/internal/reminders?date=' + tomorrow, { headers: headers, muteHttpExceptions: true });
  const body = JSON.parse(res.getContentText() || '{}');
  if (!body.ok) throw new Error('リマインド対象を取得できませんでした: ' + res.getContentText());

  const sent = [];
  body.bookings.forEach(function (b) {
    if (!b.message) return;
    if (MailApp.getRemainingDailyQuota() <= RESERVE) { recordFailure_(b.message, '送信数の上限が近いため前日リマインドを送りませんでした'); return; }
    if (send_(b.message)) sent.push(b.id);
  });
  // 送信済みにする。あわせて保存期間を過ぎた予約データを削除
  UrlFetchApp.fetch(site + '/api/internal/reminders', {
    method: 'post', contentType: 'application/json', headers: headers, muteHttpExceptions: true,
    payload: JSON.stringify({ ids: sent, purge: true }),
  });
}

function setupTrigger() {
  ScriptApp.getProjectTriggers().filter(function (t) { return t.getHandlerFunction() === 'sendReminders'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('sendReminders').timeBased().everyDays(1).atHour(10).inTimezone('Asia/Tokyo').create();
}

// 送信テスト：お店宛に1通送る（設定の確認用。エディタから実行）
function testMail() {
  send_({ to: 'shop', subject: '【テスト】ネット予約のメール送信', body: 'Apps Script からのテストメールです。\n残りの送信数（今日）：' + MailApp.getRemainingDailyQuota(), fromName: 'ネット予約' });
}

// ---------- 共通 ----------
function send_(m) {
  if (!m || !m.to || !m.subject) return false;
  const to = m.to === 'shop' ? (prop_('SHOP_EMAIL') || Session.getEffectiveUser().getEmail()) : m.to;
  try {
    if (MailApp.getRemainingDailyQuota() < 1) throw new Error('今日の送信数の上限に達しました');
    GmailApp.sendEmail(to, m.subject, m.body || '', { name: m.fromName || 'ネット予約' });
    return true;
  } catch (err) {
    console.error(err);
    recordFailure_(m, String(err && err.message || err));
    return false;
  }
}

// 送れなかったメールを記録（最大50件）
function recordFailure_(m, reason) {
  const p = PropertiesService.getScriptProperties();
  let list = [];
  try { list = JSON.parse(p.getProperty('FAILED') || '[]'); } catch (e) {}
  list.push({ at: Utilities.formatDate(new Date(), 'Asia/Tokyo', 'M/d HH:mm'), to: m.to, subject: m.subject, reason: reason });
  p.setProperty('FAILED', JSON.stringify(list.slice(-50)));
}

// 記録した失敗をお店にまとめて知らせる
function reportFailures_() {
  const p = PropertiesService.getScriptProperties();
  let list = [];
  try { list = JSON.parse(p.getProperty('FAILED') || '[]'); } catch (e) {}
  if (!list.length || MailApp.getRemainingDailyQuota() < 1) return;
  const lines = list.map(function (f) { return '・' + f.at + '　' + (f.to === 'shop' ? 'お店宛' : f.to) + '　' + f.subject + '（' + f.reason + '）'; });
  const to = prop_('SHOP_EMAIL') || Session.getEffectiveUser().getEmail();
  GmailApp.sendEmail(to, '【ネット予約】送れなかったメールがあります（' + list.length + '件）',
    '次のメールが送れませんでした。必要に応じて、お客様にお電話でご連絡ください。\n\n' + lines.join('\n'), { name: 'ネット予約' });
  p.deleteProperty('FAILED');
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
