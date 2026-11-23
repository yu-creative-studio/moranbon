-- MORANBON ネット予約 v1.1：卓ごとの予約表（電話予約の手入力）
-- 0001 を実行済みのデータベースで、1回だけ実行する。予約データはそのまま引き継がれる。

-- 卓の一覧（管理画面の「設定」から名前・人数・並び順を変えられる）
CREATE TABLE IF NOT EXISTS tables (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  name     TEXT    NOT NULL,
  capacity INTEGER NOT NULL,                 -- 4 / 6 / 宴会場は 30
  web_ok   INTEGER NOT NULL DEFAULT 1,       -- ネット予約を割り当ててよい卓か
  active   INTEGER NOT NULL DEFAULT 1,
  sort     INTEGER NOT NULL DEFAULT 0
);
INSERT INTO tables (name, capacity, web_ok, sort)
SELECT column1, column2, column3, column4 FROM (VALUES
  ('4人卓 1', 4, 1, 1), ('4人卓 2', 4, 1, 2), ('4人卓 3', 4, 1, 3), ('4人卓 4', 4, 1, 4),
  ('4人卓 5', 4, 1, 5), ('4人卓 6', 4, 1, 6), ('4人卓 7', 4, 1, 7),
  ('6人卓 1', 6, 1, 8), ('6人卓 2', 6, 1, 9),
  ('宴会場', 30, 0, 10)
) WHERE NOT EXISTS (SELECT 1 FROM tables);

-- 予約に「卓」「終了時刻」「受付経路（ネット／電話）」を持たせる
CREATE TABLE bookings_v2 (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  code          TEXT    NOT NULL UNIQUE,
  source        TEXT    NOT NULL DEFAULT 'web' CHECK (source IN ('web', 'phone')),
  date          TEXT    NOT NULL,
  start_time    TEXT    NOT NULL,
  start_min     INTEGER NOT NULL,
  end_min       INTEGER NOT NULL,                -- 終了時刻（分）。ネット予約は開始＋120
  party_size    INTEGER NOT NULL,
  table_type    INTEGER,                         -- ネット予約の卓種（4/6）。電話予約は卓の人数
  table_id      INTEGER,                         -- 座る卓（tables.id）
  name_kana     TEXT    NOT NULL,                -- 電話予約は漢字でもよい
  phone         TEXT    NOT NULL DEFAULT '',
  email         TEXT    NOT NULL DEFAULT '',
  note          TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'confirmed' CHECK (status IN ('confirmed', 'canceled')),
  created_at    TEXT    NOT NULL,
  canceled_at   TEXT,
  canceled_by   TEXT,
  reminder_sent INTEGER NOT NULL DEFAULT 0
);
INSERT INTO bookings_v2 (id, code, source, date, start_time, start_min, end_min, party_size, table_type, table_id,
                         name_kana, phone, email, note, status, created_at, canceled_at, canceled_by, reminder_sent)
SELECT id, code, 'web', date, start_time, start_min, start_min + 120, party_size, table_type, NULL,
       name_kana, phone, email, note, status, created_at, canceled_at, canceled_by, reminder_sent
FROM bookings;
DROP TABLE bookings;
ALTER TABLE bookings_v2 RENAME TO bookings;
CREATE INDEX IF NOT EXISTS idx_bookings_slot ON bookings (date, status, start_min);
CREATE INDEX IF NOT EXISTS idx_bookings_table ON bookings (date, table_id, status);

-- これまでのネット予約を、空いている卓に割り当てる（開始時刻の早い順）
UPDATE bookings SET table_id = (
  SELECT t.id FROM tables t
  WHERE t.active = 1 AND t.web_ok = 1 AND t.capacity = bookings.table_type
    AND NOT EXISTS (SELECT 1 FROM bookings o
                    WHERE o.table_id = t.id AND o.date = bookings.date AND o.status = 'confirmed'
                      AND o.start_min < bookings.end_min AND o.end_min > bookings.start_min)
  ORDER BY t.sort, t.id LIMIT 1)
WHERE status = 'confirmed' AND table_id IS NULL;
