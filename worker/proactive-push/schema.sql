-- Proactive Push Accelerator — D1 schema
--
-- 一張表夠用。endpoint + char_id 作為聯合主鍵：一個瀏覽器訂閱對多
-- 個角色獨立調度，互不影響。

CREATE TABLE IF NOT EXISTS schedules (
  endpoint        TEXT    NOT NULL,
  char_id         TEXT    NOT NULL,
  p256dh          TEXT    NOT NULL,
  auth            TEXT    NOT NULL,
  interval_ms     INTEGER NOT NULL,
  next_fire_at    INTEGER NOT NULL,    -- epoch ms，下次應當發 wake push 的時間
  last_heartbeat  INTEGER NOT NULL,    -- epoch ms，客戶端最近一次 heartbeat
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (endpoint, char_id)
);

-- cron 每次都按 next_fire_at 掃，單列索引足夠。
CREATE INDEX IF NOT EXISTS idx_schedules_next_fire ON schedules(next_fire_at);
