-- MORANBON ネット予約 v1
-- Cloudflare D1 のコンソール、または
--   npx wrangler d1 execute moranbon-reserve --remote --file=setup/migrations/0001_init.sql
-- で実行する。

CREATE TABLE IF NOT EXISTS bookings (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,          -- 予約番号（英数8桁）
  date          TEXT    NOT NULL,                 -- 来店日 YYYY-MM-DD（日本時間）
  start_time    TEXT    NOT NULL,                 -- 開始時刻 HH:MM
  start_min     INTEGER NOT NULL,                 -- 開始時刻を0時からの分で（17:30 → 1050）
  party_size    INTEGER NOT NULL,
  table_type    INTEGER NOT NULL CHECK (table_type IN (4, 6)),
  name_kana     TEXT    NOT NULL,
  phone         TEXT    NOT NULL,                 -- 数字のみで保存
  email         TEXT    NOT NULL,
  note          TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'canceled')),
  created_at    TEXT    NOT NULL,                 -- ISO 8601（UTC）
  canceled_at   TEXT,
  canceled_by   TEXT,                             -- 'guest' / 'admin'
  reminder_sent INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings (date, table_type, status, start_min);

-- 臨時休業・貸切。start_time が NULL なら終日
CREATE TABLE IF NOT EXISTS closures (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT NOT NULL,
  start_time TEXT,
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_closures_date ON closures (date);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (key, value) VALUES
  ('web_cap_4', '2'),        -- ネットに出す4人卓の数
  ('web_cap_6', '1'),        -- ネットに出す6人卓の数
  ('max_days_ahead', '0');   -- 何日先まで受け付けるか（0＝制限なし）

-- 管理画面ログインの失敗記録（回数制限用）
CREATE TABLE IF NOT EXISTS login_attempts (
  id  INTEGER PRIMARY KEY AUTOINCREMENT,
  ip  TEXT NOT NULL,
  at  INTEGER NOT NULL      -- UNIX秒
);
CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (ip, at);
