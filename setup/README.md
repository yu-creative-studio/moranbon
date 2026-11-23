# MORANBON ネット予約 v1 — セットアップ手順

サイト本体（index.html）と同じリポジトリに入っています。Cloudflare Pages が GitHub から自動でデプロイします。

| パス | 内容 |
|---|---|
| `/reserve/` | お客さん向け予約画面 |
| `/reserve/cancel/` | キャンセル画面（予約番号＋電話番号） |
| `/admin/` | 管理画面（パスワード付き） |
| `/privacy/` | 個人情報の取り扱い（**公開前にお店と確認**） |
| `functions/api/…` | API（Pages Functions） |
| `setup/` | SQL・Apps Script・ローカル確認用。サイトとしては公開されない（404） |

## 1. D1（予約データ）を作る

1. Cloudflare ダッシュボード → **Workers & Pages → D1 SQL Database → Create**。名前は `moranbon-reserve`
2. 作ったデータベースの **Console** に `setup/migrations/0001_init.sql` → `0002_tables.sql` の順に、中身を貼り付けて実行（それぞれ1回だけ）
3. **Workers & Pages → moranbon（Pages プロジェクト）→ Settings → Bindings → Add → D1 database**
   - Variable name：`DB`
   - D1 database：`moranbon-reserve`
   - Production と Preview の両方に設定する

## 2. 環境変数（シークレット）

**Settings → Variables and Secrets** に、種類「Secret」で追加する。

| 名前 | 中身 |
|---|---|
| `ADMIN_PASSWORD` | 管理画面のパスワード（8文字以上。家族に伝えるもの） |
| `SESSION_SECRET` | ログイン状態の署名用。32文字以上のランダムな文字列 |
| `GAS_SECRET` | Apps Script との合言葉。24文字以上のランダムな文字列 |
| `GAS_WEBHOOK_URL` | 手順3で作る Apps Script の URL（…/exec） |

ランダムな文字列は、ターミナルで `openssl rand -base64 36` などで作れます。
設定を変えたら **Deployments → 最新 → Retry deployment** で反映。

## 3. メール（Google Apps Script）

1. お店の Google アカウントで https://script.google.com → **新しいプロジェクト**
2. `setup/gas/Code.gs` の中身を貼り付けて保存
3. **プロジェクトの設定 → スクリプト プロパティ** に追加
   - `GAS_SECRET`：手順2と同じ値
   - `SITE_URL`：`https://moranbong-yakiniku.com`
   - `SHOP_EMAIL`：予約通知を受け取るアドレス（省略するとこのアカウント宛）
4. **デプロイ → 新しいデプロイ → ウェブアプリ**（実行ユーザー：自分／アクセス：全員）→ URL を `GAS_WEBHOOK_URL` に設定
5. 関数 `setupTrigger` を一度だけ実行（Gmail 送信の許可を求められたら承認）。毎日10時台に前日リマインドが送られる
6. 前日リマインドの処理のついでに、来店日から1年を過ぎた予約データを削除する

Gmail の送信上限は無料アカウントで1日100通ほど。予約・キャンセル・リマインドで1件あたり最大3通なので、1日30件程度までは問題なし。

## 4. ローカルで確認する

```sh
node setup/dev/server.mjs --memory      # http://127.0.0.1:8788/  管理画面のパスワード：moranbon-dev
node --test setup/dev/test.mjs          # ルール・DBのテスト
BASE=http://127.0.0.1:8788 node --test setup/dev/test.mjs   # API のテストも（サーバー起動中に）
```

Node.js 22 以上が必要（D1 の代わりに node:sqlite を使う）。メールは送らず、`http://127.0.0.1:8788/__gas` に届いた中身が見られる。

## 5. 予約表（電話予約の手入力）

- 管理画面の「予約表」タブ：縦が卓、横が 17:30〜21:30 の30分マス。空いているマスをタップすると電話予約を入れられる
- 予約をタップすると、卓の移動・時間の変更・取り消しができる。同じ卓で時間が重なる場合は保存しない
- 電話予約で卓が埋まると、ネット予約でもその時間は満席になる（ネットの残り＝「ネットに出す卓数の残り」と「実際に空いている卓の数」の少ない方）
- ネット予約は、空いている卓に自動で割り当てる（並び順の上から）
- 卓の名前・人数・並び順・ネットに使うかは「設定」タブで変えられる。宴会場など4人卓・6人卓以外はネットに出さない

## 6. 予約ルール（コードの場所）

- `functions/_lib/rules.js`：営業時間・2時間制・定休日・当日1時間前・キャンセル期限・入力チェック
- `functions/_lib/db.js`：空き計算と予約作成。空き確認と作成は **1つの条件付き INSERT** で行うので、同時に予約が来ても上限を超えない
- 「同時に何卓使っているか」で判定する（例：17:30 と 19:30 の予約は同時には座らないので、18:30 にもう1組入れる）
- ネットに出す卓数・受付日数は管理画面の「設定」から変更できる（`settings` テーブル）

## 7. 公開前チェック

- [ ] 席数・卓の内訳（仕様書の仮の数字）をお店に確認し、管理画面の「設定」で合わせる
- [ ] `/privacy/` の内容をお店と確認し、制定日を入れる
- [ ] 家族に管理画面を触ってもらう（ログイン、予約の取り消し、休業の設定）
- [ ] 自分で予約 → 確認メール → キャンセル → キャンセルメール を一通り試す
- [ ] 翌日の予約を入れて、前日リマインドが届くか確認する
