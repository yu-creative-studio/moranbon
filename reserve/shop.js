// お店の情報を /api/config（functions/shop.config.js）から読み込んで、画面に入れる
//   <span data-shop="shop.name"></span>   … 文字を入れる（texts.hoursLine など、/api/config のキー）
//   <a data-shop-tel>                     … href="tel:…" にする（中身が空なら電話番号も入れる）
//   <img data-shop-logo>                  … ロゴの画像と alt
//   <span data-shop-sub="reserve">        … brand.subtitle の小さな文字（空なら隠す）
//   <title>ネット予約</title>             … 「ネット予約｜店名」にする

const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);

let cache = null;
export async function loadShop() {
  if (!cache) {
    cache = fetch('/api/config').then((r) => r.json()).then((cfg) => {
      if (!cfg?.ok) throw new Error(cfg?.error || '設定を読み込めませんでした');
      return cfg;
    });
  }
  const cfg = await cache;
  applyShop(cfg);
  return cfg;
}

export function applyShop(cfg, root = document) {
  root.querySelectorAll('[data-shop]').forEach((el) => { el.textContent = get(cfg, el.dataset.shop) ?? ''; });
  root.querySelectorAll('[data-shop-tel]').forEach((el) => {
    el.href = `tel:${cfg.shop.telHref}`;
    if (!el.textContent.trim()) el.textContent = cfg.shop.tel;
  });
  root.querySelectorAll('img[data-shop-logo]').forEach((el) => {
    if (cfg.brand.logo) el.src = cfg.brand.logo;
    el.alt = cfg.brand.logoAlt || cfg.shop.name;
  });
  root.querySelectorAll('[data-shop-sub]').forEach((el) => {
    const t = cfg.brand.subtitle?.[el.dataset.shopSub] || '';
    el.textContent = t; el.hidden = !t;
  });
  if (root === document) {
    if (!document.title.includes(cfg.shop.name)) document.title = `${document.title}｜${cfg.shop.name}`;
    if (cfg.brand.themeColor) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cfg.brand.themeColor);
    if (cfg.brand.icon) {
      let link = document.querySelector('link[rel="icon"]');
      if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.append(link); }
      link.href = cfg.brand.icon;
    }
  }
}
