// メール通知は Google Apps Script（お店の Gmail）に任せる。
// ここでは予約内容を Apps Script のウェブアプリに送るだけ。送信に失敗しても予約自体は成立させる。

const publicBooking = (b) => ({
  id: b.id, code: b.code, date: b.date, start_time: b.start_time, party_size: b.party_size,
  table_type: b.table_type, name_kana: b.name_kana, phone: b.phone, email: b.email, note: b.note,
  status: b.status, canceled_by: b.canceled_by ?? null,
});

export async function notify(env, type, booking, origin) {
  if (!env.GAS_WEBHOOK_URL || !env.GAS_SECRET) {
    console.warn('GAS_WEBHOOK_URL / GAS_SECRET が未設定のため、メールを送りません');
    return false;
  }
  try {
    const res = await fetch(env.GAS_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ secret: env.GAS_SECRET, type, booking: publicBooking(booking), site: origin }),
      redirect: 'follow',
    });
    if (!res.ok) console.error('Apps Script へ通知できませんでした', res.status);
    return res.ok;
  } catch (e) {
    console.error('Apps Script へ通知できませんでした', e);
    return false;
  }
}

// レスポンスを返したあとで送る（お客さんを待たせない）
export const notifyLater = (ctx, type, booking) =>
  ctx.waitUntil(notify(ctx.env, type, booking, new URL(ctx.request.url).origin));
