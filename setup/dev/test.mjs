// 予約ルールの自動テスト
//   node --test setup/dev/test.mjs                 … ルールとDBのテスト
//   BASE=http://127.0.0.1:8788 node --test setup/dev/test.mjs   … APIのテストも（server.mjs --memory を起動しておく）
import test from 'node:test';
import assert from 'node:assert/strict';
import { D1 } from './d1.mjs';
import * as R from '../../functions/_lib/rules.js';
import * as DB from '../../functions/_lib/db.js';
import * as C from '../../functions/_lib/config.js';
import * as M from '../../functions/_lib/mail.js';
import shopConfig from '../../functions/shop.config.js';

// 「ルール」「DB」「API」のテストは、モランボンの設定（17:30〜19:30、2時間制、月曜・第2火曜休み、4人卓2・6人卓1）
// を前提に書いてある。別のお店の設定にしたときは自動でスキップし、最後の「どの設定でも通るテスト」だけ動く
const SAMPLE = shopConfig.shop.name === '焼肉 モランボン' && shopConfig.web.slots.join() === '17:30,18:00,18:30,19:00,19:30';
const only = SAMPLE ? {} : { skip: 'モランボンの設定用のテスト' };

const guest = { name_kana: 'ヤマダ タロウ', phone: '09012345678', email: 'taro@example.com', note: '' };
const NOW = { date: '2026-12-01', minutes: 10 * 60, ms: Date.parse('2026-12-01T01:00:00Z') }; // 12/1(火) 10:00 JST
const DAY = '2026-12-03'; // 木曜日

const book = (db, time, party = 2, now = NOW, date = DAY, g = guest) =>
  DB.createBooking(db, { date, time, party_size: party }, g, now);

// ---------- ルール ----------
test('定休日：毎週月曜日', only, () => {
  assert.ok(R.regularHoliday('2026-11-23'));
  assert.ok(R.regularHoliday('2026-12-07'));
});
test('定休日：第2火曜日（8〜14日の火曜）だけ休み', only, () => {
  assert.ok(R.regularHoliday('2026-11-10'));   // 第2火曜
  assert.ok(R.regularHoliday('2026-12-08'));   // 第2火曜
  assert.equal(R.regularHoliday('2026-11-03'), null); // 第1火曜
  assert.equal(R.regularHoliday('2026-11-17'), null); // 第3火曜
  assert.equal(R.regularHoliday('2026-12-01'), null); // 第1火曜
  assert.ok(R.regularHoliday('2026-12-14'));   // 第2週の月曜 → 月・火の連休
});
test('日本時間への変換（UTCの15:00で日付が変わる）', only, () => {
  assert.deepEqual(R.nowJst(Date.parse('2026-11-23T14:59:00Z')).date, '2026-11-23');
  assert.equal(R.nowJst(Date.parse('2026-11-23T14:59:00Z')).minutes, 23 * 60 + 59);
  assert.equal(R.nowJst(Date.parse('2026-11-23T15:00:00Z')).date, '2026-11-24');
});
test('当日は来店1時間前まで', only, () => {
  const at = (h, m) => ({ date: DAY, minutes: h * 60 + m });
  assert.equal(R.slotPassed(DAY, '17:30', at(16, 30)), false);
  assert.equal(R.slotPassed(DAY, '17:30', at(16, 31)), true);
  assert.equal(R.slotPassed(DAY, '19:30', at(18, 0)), false);
  assert.equal(R.slotPassed('2026-12-04', '17:30', at(23, 0)), false);
});
test('ネットのキャンセルは前日23:59まで', only, () => {
  assert.equal(R.canCancelOnline(DAY, '18:00', { date: '2026-12-02', minutes: 23 * 60 + 59 }), true);
  assert.equal(R.canCancelOnline(DAY, '18:00', { date: DAY, minutes: 0 }), false);
});
test('人数で卓を決める', only, () => {
  assert.equal(R.tableTypeFor(1), 4); assert.equal(R.tableTypeFor(4), 4);
  assert.equal(R.tableTypeFor(5), 6); assert.equal(R.tableTypeFor(6), 6);
});
test('入力チェック', only, () => {
  const ok = R.validateGuest({ name_kana: 'やまだ　たろう', phone: '０９０-１２３４-５６７８', email: 'a@b.jp' });
  assert.equal(ok.ok, true);
  assert.equal(ok.value.name_kana, 'ヤマダ タロウ');
  assert.equal(ok.value.phone, '09012345678');
  assert.equal(R.validateGuest({ name_kana: '山田', phone: '090', email: 'x' }).ok, false);
  assert.equal(R.validateGuest({ ...guest, note: 'あ'.repeat(301) }).ok, false);
});

// ---------- DB（空き計算・二重予約防止） ----------
test('満席：同じ時間の4人卓は2組まで', only, async () => {
  const db = new D1();
  assert.ok((await book(db, '18:00')).booking);
  assert.ok((await book(db, '18:00')).booking);
  const third = await book(db, '18:00');
  assert.ok(third.error && third.full);
  assert.ok((await book(db, '18:00', 5)).booking, '6人卓は別枠');
  assert.ok((await book(db, '18:00', 6)).error, '6人卓も1卓まで');
});
test('2時間制：重なる時間は埋まり、重ならない時間は取れる', only, async () => {
  const db = new D1();
  await book(db, '18:00'); await book(db, '18:00');
  assert.ok((await book(db, '17:30')).error, '17:30〜19:30 は 18:00 の2組と重なる');
  assert.ok((await book(db, '19:30')).error, '19:30〜 も 18:00〜20:00 と重なる');
  const days = await DB.availability(db, DAY, DAY, NOW);
  assert.deepEqual(days[0].slots.map((s) => s.t4), [0, 0, 0, 0, 0]);
});
test('同時に使っている卓数で判定する（17:30と19:30は同時には座らない）', only, async () => {
  const db = new D1();
  await book(db, '17:30'); await book(db, '19:30');
  assert.ok((await book(db, '18:30')).booking, '18:30 はどの時点でも同時に2卓まで');
  assert.ok((await book(db, '18:30')).error, '2組目の 18:30 は 19:00 の時点で3卓になる');
});
test('同時予約：10件同時に送っても上限を超えない', only, async () => {
  const db = new D1();
  const results = await Promise.all(Array.from({ length: 10 }, () => book(db, '19:00')));
  assert.equal(results.filter((r) => r.booking).length, 2);
  const { results: rows } = await db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE status='confirmed'").all();
  assert.equal(rows[0].n, 2);
});
test('定休日・第2火曜・過去・時間外・人数外は予約できない', only, async () => {
  const db = new D1();
  assert.match((await book(db, '18:00', 2, NOW, '2026-12-07')).error, /月曜/);
  assert.match((await book(db, '18:00', 2, NOW, '2026-12-08')).error, /第2火曜/);
  assert.match((await book(db, '18:00', 2, NOW, '2026-11-30')).error, /過去/);
  assert.ok((await book(db, '20:00')).error);
  assert.ok((await book(db, '17:00')).error);
  assert.match((await book(db, '18:00', 7)).error, /7名/);
  assert.ok((await book(db, '18:00', 0)).error);
});
test('当日1時間前ルール（API層でも）', only, async () => {
  const db = new D1();
  const today = { date: DAY, minutes: 17 * 60, ms: NOW.ms };
  assert.match((await book(db, '17:30', 2, today)).error, /1時間前/);
  assert.match((await book(db, '18:00', 2, today)).error ?? '', /^$/, '18:00 はちょうど1時間前なので取れる');
  const days = await DB.availability(db, DAY, DAY, today);
  assert.equal(days[0].slots[0].t4, 0);
});
test('臨時休業：終日と時間帯', only, async () => {
  const db = new D1();
  await DB.addClosure(db, DAY, '18:00', '貸切', NOW);
  assert.ok((await book(db, '18:00')).error);
  assert.ok((await book(db, '18:30')).booking);
  await DB.addClosure(db, '2026-12-04', null, '臨時休業', NOW);
  assert.ok((await book(db, '18:30', 2, NOW, '2026-12-04')).error);
  const days = await DB.availability(db, '2026-12-04', '2026-12-04', NOW);
  assert.equal(days[0].open, false);
});
test('受付日数の上限（設定値）', only, async () => {
  const db = new D1();
  await DB.saveSettings(db, { max_days_ahead: 30 });
  assert.match((await book(db, '18:00', 2, NOW, '2027-01-05')).error, /30日先/);
  await DB.saveSettings(db, { max_days_ahead: 0 });
  assert.ok((await book(db, '18:00', 2, NOW, '2027-06-03')).booking);
});
test('卓数の変更が空き計算に反映される', only, async () => {
  const db = new D1();
  await DB.saveSettings(db, { web_cap_4: 0 });
  assert.ok((await book(db, '18:00')).error);
  await DB.saveSettings(db, { web_cap_4: 3 });
  for (let i = 0; i < 3; i++) assert.ok((await book(db, '18:00')).booking);
  assert.ok((await book(db, '18:00')).error);
});
test('キャンセル：前日まではネット、当日は電話。キャンセルで枠が空く', only, async () => {
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
test('前日リマインドの対象と送信済みフラグ、1年経過データの削除', only, async () => {
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

// ---------- 予約表（卓・電話予約） ----------
const tablesOf = async (db, cap) => (await DB.listTables(db)).filter((t) => t.capacity === cap);
const phone = (db, table_id, start, end, extra = {}) =>
  DB.addPhoneBooking(db, { date: DAY, table_id, start_min: R.toMin(start), end_min: R.toMin(end), party_size: 4, name_kana: '鈴木', ...extra }, NOW);

test('ネット予約は空いている卓に自動で割り当てられる', only, async () => {
  const db = new D1();
  const t4 = await tablesOf(db, 4);
  const a = (await book(db, '18:00')).booking, b = (await book(db, '18:00')).booking;
  assert.equal(a.table_id, t4[0].id); assert.equal(b.table_id, t4[1].id);
  assert.equal(a.end_min, R.toMin('20:00'));
  const c = (await book(db, '18:00', 6)).booking;
  assert.equal((await tablesOf(db, 6))[0].id, c.table_id);
});
test('電話予約で卓が埋まると、ネットでも満席になる', only, async () => {
  const db = new D1();
  const t4 = await tablesOf(db, 4);
  for (const t of t4.slice(0, 6)) assert.ok((await phone(db, t.id, '18:00', '20:00')).booking);
  let [day] = await DB.availability(db, DAY, DAY, NOW);
  assert.equal(day.slots.find((s) => s.time === '18:00').t4, 1, '空いている4人卓は1卓だけ');
  assert.equal(day.slots.find((s) => s.time === '17:30').t4, 1);
  assert.ok((await book(db, '18:00')).booking);
  assert.ok((await book(db, '19:00')).error, '4人卓が全部埋まった');
  [day] = await DB.availability(db, DAY, DAY, NOW);
  assert.equal(day.slots.find((s) => s.time === '19:30').t4, 0);
  assert.equal(day.slots.find((s) => s.time === '18:00').t6, 1, '6人卓は空いている');
});
test('電話予約：同じ卓の重なりは入らない。続けての予約や宴会場は入る', only, async () => {
  const db = new D1();
  const [t] = await tablesOf(db, 4);
  assert.ok((await phone(db, t.id, '17:30', '19:30')).booking);
  assert.equal((await phone(db, t.id, '19:00', '21:00')).status, 409);
  assert.ok((await phone(db, t.id, '19:30', '21:30')).booking, '19:30 からは空いている');
  assert.match((await phone(db, t.id, '21:00', '22:00')).error, /閉店/);
  assert.match((await phone(db, t.id, '17:00', '18:00')).error, /17:30/);
  assert.match((await phone(db, t.id, '18:15', '19:00')).error, /30分/);
  const hall = (await DB.listTables(db)).find((x) => x.capacity === 30);
  const big = await phone(db, hall.id, '18:00', '21:00', { party_size: 28, name_kana: '上田商事 忘年会' });
  assert.ok(big.booking);
  assert.equal(big.booking.source, 'phone');
});
test('予約の移動・時間変更：重なる先には移せない', only, async () => {
  const db = new D1();
  const [t1, t2] = await tablesOf(db, 4);
  const a = (await phone(db, t1.id, '18:00', '20:00')).booking;
  const b = (await phone(db, t2.id, '18:00', '20:00')).booking;
  assert.equal((await DB.updateBooking(db, b.id, { table_id: t1.id })).status, 409);
  const moved = await DB.updateBooking(db, b.id, { table_id: t1.id, start_min: R.toMin('20:00'), end_min: R.toMin('21:30') });
  assert.equal(moved.booking.start_time, '20:00');
  assert.ok((await DB.updateBooking(db, a.id, { end_min: R.toMin('20:00'), party_size: 3 })).booking, '自分自身とは重ならない');
  await DB.cancelById(db, a.id, 'admin', NOW);
  assert.equal((await DB.updateBooking(db, a.id, { party_size: 2 })).status, 409, 'キャンセル済みは変更しない');
});
test('卓の設定：宴会場はネットに出さない。止めた卓はネットで使わない', only, async () => {
  const db = new D1();
  let tables = await DB.listTables(db, { all: true });
  tables = tables.map((t) => ({ ...t, web_ok: 1 }));
  tables = await DB.saveTables(db, tables);
  assert.equal(tables.find((t) => t.capacity === 30).web_ok, 0);
  const six = tables.filter((t) => t.capacity === 6);
  await DB.saveTables(db, tables.map((t) => (six.some((s) => s.id === t.id) ? { ...t, active: 0 } : t)));
  assert.ok((await book(db, '18:00', 6)).error, '6人卓がないので入らない');
});

// ---------- API（BASE を指定したときだけ） ----------
const BASE = process.env.BASE;
const api = (p, opt = {}) => fetch(BASE + p, { ...opt, headers: { 'content-type': 'application/json', ...(opt.headers || {}) } })
  .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null), headers: r.headers }));

test('API：予約〜キャンセル〜管理画面', { skip: !BASE || (!SAMPLE && 'モランボンの設定用のテスト') }, async () => {
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
  const sent = inbox.find((m) => m.type === 'booked' && m.booking.code === code && m.secret);
  assert.ok(sent);
  assert.equal(sent.messages.length, 2, 'お客さん宛とお店宛');
  assert.equal(sent.messages[0].to, guest.email);
  assert.match(sent.messages[0].body, new RegExp(code));
  assert.equal(sent.messages[1].to, 'shop');
  // 画面用の設定
  const cfg = await api('/api/config');
  assert.equal(cfg.body.shop.name, shopConfig.shop.name);
  assert.deepEqual(cfg.body.web.slots, shopConfig.web.slots);
  assert.equal(cfg.body.mail, undefined, 'メールの文面は画面に出さない');

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
  const rem = await api('/api/internal/reminders?date=' + date, { headers: { 'x-reserve-secret': 'dev-gas-secret-0123456789abcdef' } });
  assert.equal(rem.body.bookings.length, 1);
  assert.match(rem.body.bookings[0].message.subject, /明日/);
  const old = await api('/api/internal/reminders?date=' + date, { headers: { 'x-moranbon-secret': 'dev-gas-secret-0123456789abcdef' } });
  assert.equal(old.status, 200, '古い Apps Script のヘッダーも通る');
});

test('API：ログイン失敗は15分に5回まで', { skip: !BASE || (!SAMPLE && 'モランボンの設定用のテスト') }, async () => {
  const bad = () => api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'wrong' }) });
  const codes = [];
  for (let i = 0; i < 6; i++) codes.push((await bad()).status);
  assert.deepEqual(codes, [401, 401, 401, 401, 401, 429]);
  const good = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'moranbon-dev' }) });
  assert.equal(good.status, 429, '正しいパスワードでも待ち時間中は入れない');
});

// ---------- どの設定でも通るテスト（新しいお店の設定にしたあとも動く） ----------
test('設定：shop.config.js に間違いがない', () => {
  assert.deepEqual(C.checkConfig(shopConfig), []);
});
test('設定：間違いを見つける', () => {
  const bad = structuredClone(shopConfig);
  bad.hours = { open: '17:30', close: '21:00', step: 30 };
  bad.web.slots = ['19:30', '17:30'];
  bad.web.maxParty = 8;
  bad.closedDays = [{ weekday: '水曜', nth: 6 }];
  const errs = C.checkConfig(bad).join('\n');
  assert.match(errs, /早い順/);
  assert.match(errs, /maxParty/);
  assert.match(errs, /nth/);
  const late = structuredClone(shopConfig);
  late.hours.close = late.web.slots.at(-1); // 最後の来店時刻＋滞在時間が閉店を超える
  assert.match(C.checkConfig(late).join('\n'), /閉店/);
});
test('定休日の書き方：毎週・第n・最終', () => {
  const rules = [{ dow: 3, nth: null }, { dow: 0, nth: 1 }, { dow: 5, nth: -1 }];
  assert.ok(R.regularHoliday('2026-11-25', rules));          // 水曜
  assert.ok(R.regularHoliday('2026-11-01', rules));          // 第1日曜
  assert.equal(R.regularHoliday('2026-11-08', rules), null); // 第2日曜
  assert.ok(R.regularHoliday('2026-11-27', rules));          // 最終金曜
  assert.equal(R.regularHoliday('2026-11-20', rules), null); // 最終ではない金曜
  assert.equal(R.regularHoliday('2026-11-24', []), null);
});
test('キャンセル期限の設定：前日・2日前・当日', () => {
  const day = '2026-12-10';
  const at = (date, h = 12) => ({ date, minutes: h * 60 });
  assert.equal(R.canCancelOnline(day, R.SLOTS[0], at('2026-12-09'), 1), true);
  assert.equal(R.canCancelOnline(day, R.SLOTS[0], at('2026-12-09'), 2), false);
  assert.equal(R.canCancelOnline(day, R.SLOTS[0], at('2026-12-08'), 2), true);
  assert.equal(R.canCancelOnline(day, R.SLOTS[0], at(day, 0), 0), true);
  assert.equal(R.canCancelOnline(day, R.SLOTS[0], at(day, 23), 0), false);
});
test('滞在時間ぶんの時点を見る', () => {
  assert.equal(R.coveredPoints(R.toMin(R.SLOTS[0])).length, R.STAY_MIN / R.GRID_STEP);
  assert.deepEqual(R.coveredPoints(600, 90).map(R.fromMin), R.GRID_STEP === 30 ? ['10:00', '10:30', '11:00'] : R.coveredPoints(600, 90).map(R.fromMin));
});
test('メール：設定の文面で組み立てる', () => {
  const b = { code: 'AB3CD7EF', date: '2026-12-10', start_time: R.SLOTS[0], party_size: 2, name_kana: 'ヤマダ タロウ', phone: '09012345678', email: 'a@b.jp', note: '', table_type: 4 };
  const msgs = M.messagesFor('booked', b, 'https://example.com');
  assert.equal(msgs.length, 2);
  assert.match(msgs[0].body, /AB3CD7EF/);
  assert.match(msgs[0].body, /https:\/\/example\.com\/reserve\/cancel\/\?code=AB3CD7EF/);
  assert.doesNotMatch(msgs[0].body + msgs[0].subject, /\{[^}]+\}/, '置き換え忘れがない');
  assert.equal(M.messagesFor('booked', { ...b, email: '' }).length, 1, 'メールのない予約はお店宛だけ');
  assert.equal(M.messagesFor('canceled', { ...b, canceled_by: 'admin' }).length, 1, 'お店が取り消したときはお客さん宛だけ');
  assert.doesNotMatch(M.guestMessage('reminder', b).body, /\{[^}]+\}/);
});
test('予約：最初の来店時刻に1件入る（どの設定でも）', async () => {
  const db = new D1();
  let d = R.addDays(NOW.date, 2);
  while (R.regularHoliday(d)) d = R.addDays(d, 1);
  const r = await DB.createBooking(db, { date: d, time: R.SLOTS[0], party_size: 2 }, guest, NOW);
  assert.ok(r.booking, r.error);
  assert.equal(r.booking.end_min - r.booking.start_min, R.STAY_MIN);
  const over = await DB.createBooking(db, { date: d, time: R.SLOTS[0], party_size: R.MAX_PARTY + 1 }, guest, NOW);
  assert.ok(over.error);
});
