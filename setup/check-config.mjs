// functions/shop.config.js に間違いがないか確かめ、画面やメールに出る文章を一覧で見せる
//   node setup/check-config.mjs
import { checkConfig } from '../functions/_lib/config.js';

let mod;
try {
  mod = await import('../functions/_lib/config.js');
} catch (e) {
  console.error('\n✗ ' + e.message + '\n');
  process.exit(1);
}
const { config, texts, SLOTS } = mod;
const { guestMessage, shopMessage } = await import('../functions/_lib/mail.js');
const { regularHoliday, addDays } = await import('../functions/_lib/rules.js');

const errors = checkConfig(config);
if (errors.length) { console.error(errors.join('\n')); process.exit(1); }

const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const holidays = [];
for (let d = today, i = 0; i < 60; i++, d = addDays(d, 1)) { const h = regularHoliday(d); if (h) holidays.push(`${d.slice(5)} ${h}`); }

const sample = { code: 'AB3CD7EF', date: addDays(today, 3), start_time: SLOTS[0], party_size: 2, name_kana: 'ヤマダ タロウ',
  phone: '09012345678', email: 'taro@example.com', note: '', table_type: 4 };

console.log(`\n✓ 設定に問題はありません：${config.shop.name}\n`);
console.log('■ 画面に出る文章');
for (const [k, v] of Object.entries(texts)) console.log(`  ${k.padEnd(15)} ${v}`);
console.log(`\n■ これから60日の定休日（${holidays.length}日）\n  ${holidays.join('\n  ') || 'なし'}`);
console.log('\n■ 予約確認メール（お客さん宛）の例');
const m = guestMessage('booked', sample);
console.log(`  件名：${m.subject}\n  差出人名：${m.fromName}\n` + m.body.split('\n').map((l) => '  │ ' + l).join('\n'));
console.log(`\n■ お店宛の通知の件名：${shopMessage('booked', sample).subject}\n`);
