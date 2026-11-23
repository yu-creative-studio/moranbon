// 予約ルールの自動テスト
//   node --test setup/dev/test.mjs                 … ルールとDBのテスト
//   BASE=http://127.0.0.1:8788 node --test setup/dev/test.mjs   … APIのテストも（server.mjs --memory を起動しておく）
import test from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from './d1.mjs';
import * as R from '../../functions/_lib/rules.js';
import * as DB from '../../functions/_lib/db.js';

const guest = { name_kana: 'ヤマダ タロウ', phone: '09012345678', email: 'taro@example.com', note: '' };
const NOW = { date: '2026-12-01', minutes: 10 * 60, ms: Date.parse('2026-12-01T01:00:00Z') }; // 12/1(火) 10:00 JST
const DAY = '2026-12-03'; // 木曜日

const book = (db, time, party = 2, now = NOW, date = DAY, g = guest) =>
  DB.createBooking(db, { date, time, party_size: party }, g, now);

// ---------- ルール ----------
test('定休日：毎週月曜日', () => {
  assert.ok(R.regularHoliday('2026-11-23'));
  assert.ok(R.regularHoliday('2026-12-07'));
});
test('定休日：第2火曜日（8〜14日の火曜）だけ休み', () => {
  assert.ok(R.regularHoliday('2026-11-10'));   // 第2火曜
  assert.ok(R.regularHoliday('2026-12-08'));   // 第2火曜
  assert.equal(R.regularHoliday('2026-11-03'), null); // 第1火曜
  assert.equal(R.regularHoliday('2026-11-17'), null); // 第3火曜
  assert.equal(R.regularHoliday('2026-12-01'), null); // 第1火曜
  assert.ok(R.regularHoliday('2026-12-14'));   // 第2週の月曜 → 月・火の連休
});
test('日本時間への変換（UTCの15:00で日付が変わる）', () => {
  assert.deepEqual(R.nowJst(Date.parse('2026-11-23T14:59:00Z')).date, '2026-11-23');
  assert.equal(R.nowJst(Date.parse('2026-11-23T14:59:00Z')).minutes, 23 * 60 + 59);
  assert.equal(R.nowJst(Date.parse('2026-11-23T15:00:00Z')).date, '2026-11-24');
});
test('当日は来店1時間前まで', () => {
  const at = (h, m) => ({ date: DAY, minutes: h * 60 + m });
  assert.equal(R.slotPassed(DAY, '17:30', at(16, 30)), false);
  assert.equal(R.slotPassed(DAY, '17:30', at(16, 31)), true);
  assert.equal(R.slotPassed(DAY, '19:30', at(18, 0)), false);
  assert.equal(R.slotPassed('2026-12-04', '17:30', at(23, 0)), false);
});
test('ネットのキャンセルは前日23:59まで', () => {
  assert.equal(R.canCancelOnline(DAY, { date: '2026-12-02', minutes: 23 * 60 + 59 }), true);
  assert.equal(R.canCancelOnline(DAY, { date: DAY, minutes: 0 }), false);
});
test('人数で卓を決める', () => {
  assert.equal(R.tableTypeFor(1), 4); assert.equal(R.tableTypeFor(4), 4);
  assert.equal(R.tableTypeFor(5), 6); assert.equal(R.tableTypeFor(6), 6);
});
test('入力チェック', () => {
  const ok = R.validateGuest({ name_kana: 'やまだ　たろう', phone: '０９０-１２３４-５６７８', email: 'a@b.jp' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name_kana, 'ヤマダ タロウ');
  assert.equal(ok.value.phone, '09012345678');
  assert.equal(R.validateGuest({ name_kana: '山田', phone: '090', email: 'x' }).ok, false);
  assert.equal(R.validateGuest({ ...guest, note: 'あ'.repeat(301) }).ok, false);
});

// ---------- DB（空き計算・二重予約防止） ----------
test('満席：同じ時間の4人卓は2組まで', async () => {
  const db = new D1();
  assert.ok((await book(db, '18:00')).booking);
  assert.ok((await book(db, '18:00')).booking);
  const third = await book(db, '18:00');
  assert.ok(third.error && third.full);
  assert.ok((await book(db, '18:00', 5)).booking, '6人卓は別枠');
  assert.ok((await book(db, '18:00', 6)).error, '6人卓も1卓まで');
});
test('2時間制：重なる時間は埋まり、重ならない時間は取れる', async () => {
  const db = new D1();
  await book(db, '18:00'); await book(db, '18:00');
  assert.ok((await book(db, '17:30')).error, '17:30〜19:30 は 18:00 の2組と重なる');
  assert.ok((await book(db, '19:30')).error, '19:30〜 も 18:00〜20:00 と重なる');
  const days = await DB.availability(db, DAY, DAY, NOW);
  assert.deepEqual(days[0].slots.map((s) => s.t4), [0, 0, 0, 0, 0]);
});
test('同時に使っている卓数で判定する（17:30と19:30は同時には座らない）', async () => {
  const db = new D1();
  await book(db, '17:30'); await book(db, '19:30');
  assert.ok((await book(db, '18:30')).booking, '18:30 はどの時点でも同時に2卓まで');
  assert.ok((await book(db, '18:30')).error, '2組目の 18:30 は 19:00 の時点で3卓になる');
});
test('同時予約：10件同時に送っても上限を超えない', async () => {
  const db = new D1();
  const results = await Promise.all(Array.from({ length: 10 }, () => book(db, '19:00')));
  assert.equal(results.filter((r) => r.booking).length, 2);
  const { results: rows } = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed'").all();
  assert.equal(rows[0].n, 2);
});
test('定休日・第2火曜・過去・時間外・人数外は予約できない', async () => {
  const db = new D1();
  assert.match((await book(db, '18:00', 2, NOW, '2026-12-07')).error, /月曜/);
  assert.match((await book(db, '18:00', 2, NOW, '2026-12-08')).error, /第2火曜/);
  assert.match((await book(db, '18:00', 2, NOW, '2026-11-30')).error, /過去/);
  assert.ok((await book(db, '20:00')).error);
  assert.ok((await book(db, '17:00')).error);
  assert.match((await book(db, '18:00', 7)).error, /7名/);
  assert.ok((await book(db, '18:00', 0)).error);
});
test('当日1時間前ルール（API層でも）', async () => {
  const db = new D1();
  const today = { date: DAY, minutes: 17 * 60, ms: NOW.ms };
  assert.match((await book(db, '17:30', 2, today)).error, /1時間前/);
  assert.match((await book(db, '18:00', 2, today)).error ?? '', /^$/, '18:00 はちょうど1時間前なので取れる');
  const days = await DB.availability(db, DAY, DAY, today);
  assert.equal(days[0].slots[0].t4, 0);
});
test('臨時休業：終日と時間帯', async () => {
  const db = new D1();
  await DB.addClosure(db, DAY, '18:00', '貸切', NOW);
  assert.ok((await book(db, '18:00')).error);
  assert.ok((await book(db, '18:30')).booking);
  await DB.addClosure(db, '2026-12-04', null, '臨時休業', NOW);
  assert.ok((await book(db, '18:30', 2, NOW, '2026-12-04')).error);
  const days = await DB.availability(db, '2026-12-04', '2026-12-04', NOW);
  assert.equal(days[0].open, false);
});
test('受付日数の上限（設定値）', async () => {
  const db = new D1();
  await DB.saveSettings(db, { max_days_ahead: 30 });
  assert.match((await book(db, '18:00', 2, NOW, '2027-01-05')).error, /30日先/);
  await DB.saveSettings(db, { max_days_ahead: 0 });
  assert.ok((await book(db, '18:00', 2, NOW, '2027-06-03')).booking);
});
test('卓数の変更が空き計算に反映される', async () => {
  const db = new D1();
  await DB.saveSettings(db, { web_cap_4: 0 });
  assert.ok((await book(db, '18:00')).error);
  await DB.saveSettings(db, { web_cap_4: 3 });
  for (let i = 0; i < 3; i++) assert.ok((await book(db, '18:00')).booking);
  assert.ok((await book(db, '18:00')).error);
});
test('キャンセル：前日まではネット、当日は電話。キャンセルで枠が空く', async () => {
  const db = new D1();
  const a = (await book(db, '18:00')).booking; await book(db, '18:00');
  assert.ok((await book(db, '18:00')).error);
  assert.equal((await DB.guestCancel(db, a.code, '09099999999', NOW)).status, 404, '電話番号違い');
  const sameDay = { date: DAY, minutes: 9 * 60, ms: NOW.ms };
  assert.match((await DB.guestCancel(db, a.code, guest.phone, sameDay)).error, /お電話/);
  const eve = { date: '2026-12-02', minutes: 23 * 60 + 59, ms: NOW.ms };
  assert.equal((await DB.guestCancel(db, a.code, guest.phone, eve)).booking.status, 'canceled');
  assert.equal((await DB.guestCancel(db, a.code, guest.phone, eve)).status, 409, '二重キャンセル');
  assert.ok((await book(db, '18:00')).booking, '空いた枠に入れる');
});
test('前日リマインドの対象と送信済みフラグ、1年経過データの削除', async () => {
  const db = new D1();
  const a = (await book(db, '18:00')).booking; const b = (await book(db, '19:00')).booking;
  await DB.cancelById(db, b.id, 'admin', NOW);
  let t = await DB.reminderTargets(db, DAY);
  assert.deepEqual(t.map((x) => x.id), [a.id]);
  await DB.markReminded(db, [a.id]);
  t = await DB.reminderTargets(db, DAY);
  assert.equal(t.length, 0);
  const later = { date: '2027-12-04', minutes: 0, ms: NOW.ms };
  assert.equal(await DB.purgeOld(db, later), 2);
});

// ---------- API（BASE を指定したときだけ） ----------
const BASE = process.env.BASE;
const api = (p, opt = {}) => fetch(BASE + p, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));

test('API：予約〜キャンセル〜管理画面', { skip: !BASE }, async () => {
  const today = (await api('/api/availability')).body.today;
  let date = R.addDays(today, 2);
  while (R.regularHoliday(date)) date = R.addDays(date, 1);
  const post = (b) => api('/api/bookings', { method: 'POST', body: JSON.stringify({ agree: true, date, time: '18:30', party_size: 3, ...guest, ...b }) });

  assert.equal((await post({ agree: false })).status, 400);
  assert.equal((await post({ website: 'spam' })).status, 400);
  assert.equal((await post({ phone: '123' })).status, 422);

  // 同時に10件
  const many = await Promise.all(Array.from({ length: 10 }, () => post({})));
  const ok = many.filter((r) => r.status === 201);
  assert.equal(ok.length, 2);
  assert.ok(many.filter((r) => r.status === 409).length === 8);
  const code = ok[0].body.booking.code;

  // 通知が Apps Script（ダミー）に届いている
  const inbox = await fetch(BASE + '/__gas').then((r) => r.json());
  assert.ok(inbox.some((m) => m.type === 'booked' && m.booking.code === code && m.secret));

  // キャンセル
  const look = await api('/api/bookings/cancel', { method: 'POST', body: JSON.stringify({ action: 'lookup', code, phone: '090-1234-5678' }) });
  assert.equal(look.body.booking.cancelable, true);
  const c = await api('/api/bookings/cancel', { method: 'POST', body: JSON.stringify({ code, phone: guest.phone }) });
  assert.equal(c.body.booking.status, 'canceled');

  // 管理画面：未ログインは401
  assert.equal((await api('/api/admin/bookings?date=' + date)).status, 401);
  assert.equal((await api('/api/internal/reminders')).status, 403);
  // ログイン
  const login = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'moranbon-dev' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.match(login.headers.get('set-cookie'), /HttpOnly; Secure; SameSite=Strict/);
  const list = await api('/api/admin/bookings?date=' + date, { headers: { cookie } });
  assert.equal(list.status, 200);
  assert.equal(list.body.bookings.length, 2);
  // 改ざんしたCookieは通らない
  assert.equal((await api('/api/admin/me', { headers: { cookie: cookie.slice(0, -2) + 'xx' } })).body.admin, false);
  // リマインド（共有シークレット）
  const rem = await api('/api/internal/reminders?date=' + date, { headers: { 'x-moranbon-secret': 'dev-gas-secret-0123456789abcdef' } });
  assert.equal(rem.body.bookings.length, 1);
});

test('API：ログイン失敗は15分に5回まで', { skip: !BASE }, async () => {
  const bad = () => api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await bad()).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  const good = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'moranbon-dev' }) });
  assert.equal(good.status, 429, '正しいパスワードでも待ち時間中は入れない');
});
