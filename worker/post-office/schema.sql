-- 彼方虛擬郵局 · D1 schema
-- 默認無需手動執行：Worker 啟動時會自動建表（加性、不破壞老數據）。
-- 想提前建表 / 排查時可手動：
--   wrangler d1 create sullyos-post-office
--   wrangler d1 execute sullyos-post-office --file schema.sql

-- 公共信件池
CREATE TABLE IF NOT EXISTS po_letters (
  id          TEXT    PRIMARY KEY,            -- 遠端信 id (uuid)
  device      TEXT    NOT NULL,               -- 寄信方匿名 owner_id
  pen         TEXT    NOT NULL,               -- 筆名（角色名/匿名）
  content     TEXT    NOT NULL,
  lang        TEXT,
  created_at  INTEGER NOT NULL,               -- ms epoch
  reply_count INTEGER NOT NULL DEFAULT 0,
  likes       INTEGER NOT NULL DEFAULT 0,     -- 點贊數（按 po_votes 重算）
  dislikes    INTEGER NOT NULL DEFAULT 0,     -- 點踩(=舉報)數；達 PO_DISLIKE_LIMIT 即刪信
  views       INTEGER NOT NULL DEFAULT 0      -- 被抽到次數（一設備只算一次）
);
-- 老庫升級（已有 po_letters 時補列；列已存在會報錯，可忽略）：
--   ALTER TABLE po_letters ADD COLUMN likes    INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE po_letters ADD COLUMN dislikes INTEGER NOT NULL DEFAULT 0;
--   ALTER TABLE po_letters ADD COLUMN views    INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_po_letters_dev  ON po_letters(device);
CREATE INDEX IF NOT EXISTS idx_po_letters_open ON po_letters(reply_count, created_at);

-- 誰抽到過哪封信（避免同一設備重複抽到同一封）
CREATE TABLE IF NOT EXISTS po_picks (
  device    TEXT    NOT NULL,
  letter_id TEXT    NOT NULL,
  at        INTEGER NOT NULL,
  PRIMARY KEY (device, letter_id)
);

-- 回信
CREATE TABLE IF NOT EXISTS po_replies (
  id         TEXT    PRIMARY KEY,
  letter_id  TEXT    NOT NULL,                -- 被回的信
  device     TEXT    NOT NULL,                -- 回信方 owner_id
  pen        TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_replies_letter ON po_replies(letter_id);

-- owner_id(UUID) ↔ 短整數 uid 映射：多行的投票表只存 uid，省空間
CREATE TABLE IF NOT EXISTS po_devices (
  uid        INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id   TEXT    NOT NULL UNIQUE,
  created_at INTEGER NOT NULL
);

-- 投票（點贊 vote=1 / 點踩=舉報 vote=-1），一設備一票
-- ip_hash：自動刪除按「不同 IP」去重，防偽造 device 刷滿閾值刪信
CREATE TABLE IF NOT EXISTS po_votes (
  letter_id TEXT    NOT NULL,
  uid       INTEGER NOT NULL,                 -- 指向 po_devices.uid
  vote      INTEGER NOT NULL,                 -- 1 贊 / -1 踩
  at        INTEGER NOT NULL,
  ip_hash   TEXT,                             -- 加鹽 IP 哈希（舊庫 ALTER 補列）
  PRIMARY KEY (letter_id, uid)
);
-- 老庫升級：ALTER TABLE po_votes ADD COLUMN ip_hash TEXT;
CREATE INDEX IF NOT EXISTS idx_po_votes_letter ON po_votes(letter_id);

-- 限流計數（固定窗口；bucket = ipHash:action）
CREATE TABLE IF NOT EXISTS po_ratelimit (
  bucket   TEXT    PRIMARY KEY,
  count    INTEGER NOT NULL,
  reset_at INTEGER NOT NULL
);

-- ════════ 信號墜落處 / 跨用戶接龍詩 ════════
-- 複用本後端的匿名 device / 筆名 / 限流；走獨立的 po_* 表。

-- 冊子：容器 + 規格（多少首詩 / 每首句數 roll 區間 / 每句字數上限）
CREATE TABLE IF NOT EXISTS po_booklets (
  id             TEXT    PRIMARY KEY,
  title          TEXT    NOT NULL,
  subtitle       TEXT,
  theme          TEXT,
  poems_target   INTEGER NOT NULL,             -- 寫滿多少首算這本完成
  poem_count     INTEGER NOT NULL DEFAULT 0,   -- 已封存詩數（實算回填）
  lines_min      INTEGER NOT NULL,             -- 每首句數 roll 下限
  lines_max      INTEGER NOT NULL,             -- 上限
  chars_per_line INTEGER NOT NULL,             -- 每句字數上限
  status         TEXT    NOT NULL DEFAULT 'open', -- open / done
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_po_booklets_open ON po_booklets(status, created_at);

-- 詩：一首接龍詩（line_count 由 po_poem_lines 實算回填，避免併發自增漂移）
CREATE TABLE IF NOT EXISTS po_poems (
  id           TEXT    PRIMARY KEY,
  booklet_id   TEXT    NOT NULL,
  title        TEXT    NOT NULL,
  target_lines INTEGER NOT NULL,               -- roll 到的篇幅（總句數）
  line_count   INTEGER NOT NULL DEFAULT 0,
  status       TEXT    NOT NULL DEFAULT 'open', -- open / sealed
  starter_pen  TEXT,                            -- 起新篇者筆名
  created_at   INTEGER NOT NULL,
  sealed_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_po_poems_booklet ON po_poems(booklet_id, status);
CREATE INDEX IF NOT EXISTS idx_po_poems_sealed  ON po_poems(status, sealed_at);

-- 句：(poem_id, seq) 唯一，併發搶同號時第二條 INSERT 失敗 → 天然防錯位
CREATE TABLE IF NOT EXISTS po_poem_lines (
  id         TEXT    PRIMARY KEY,
  poem_id    TEXT    NOT NULL,
  booklet_id TEXT    NOT NULL,
  seq        INTEGER NOT NULL,                  -- 1-based 句號
  device     TEXT    NOT NULL,                  -- 貢獻者匿名 owner_id
  pen        TEXT    NOT NULL,                  -- 筆名（馬賽克後的角色名）
  content    TEXT    NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_po_poem_lines_seq ON po_poem_lines(poem_id, seq);
