#!/bin/sh
# Cloudflare Workers Builds 的構建命令。由 sync-workers-repo workflow 複製進
# 部署倉庫的每個 worker 目錄，CF 在 wrangler deploy 之前執行它。
#
# 存在的唯一理由：D1 的 database_id 是帳號級的，沒法預先寫死在倉庫裡。以前只能讓
# 用戶去 GitHub 網頁編輯器改一行——手機上很難受。改成讀構建變量之後，用戶在
# Cloudflare 面板填一個文本框就行（那個頁面他本來就要去設密鑰），GitHub 那邊只剩
# Fork 和 Sync fork 兩個按鈕。
#
# 需要的構建變量（Settings → Build → Variables，普通變量即可，不是 secret，
# database_id 不是敏感信息）：
#   D1_DATABASE_ID   僅當該 worker 的 wrangler.toml 裡還留著佔位符時才需要
set -eu

PLACEHOLDER='REPLACE_WITH_YOUR_D1_ID'

# 只認「生效中」的佔位符：註釋行不算。D1 是可選項的 worker 會把整個
# [[d1_databases]] 塊連同佔位符一起註釋掉——按字面匹配就會逼著不需要 D1 的
# 用戶去建庫。
if ! grep -v '^[[:space:]]*#' wrangler.toml 2>/dev/null | grep -q "$PLACEHOLDER"; then
  # 這個 worker 不需要 D1（或用戶已經把 id 直接提交進 fork 了），無事可做。
  echo "[deploy-prepare] 沒有待填的 D1 佔位符，跳過。"
  exit 0
fi

if [ -z "${D1_DATABASE_ID:-}" ]; then
  echo "[deploy-prepare] 這個 Worker 需要 D1，但構建變量 D1_DATABASE_ID 是空的。" >&2
  echo "" >&2
  echo "  怎麼修：" >&2
  echo "    1. Cloudflare 面板 → Storage & Databases → D1 → 建一個庫" >&2
  echo "    2. 進去複製它的 Database ID" >&2
  echo "    3. 回到本 Worker → Settings → Build → Variables" >&2
  echo "       加一個 D1_DATABASE_ID，值粘上去" >&2
  echo "    4. 重新跑一次部署" >&2
  exit 1
fi

# id 由 CF 生成，形如 8-4-4-4-12 的 uuid。先校驗再替換：粘歪了（比如帶上了
# 前後空格、或者複製成了庫名）在這裡報出來，比部署完發現綁定不對好排查。
if ! printf '%s' "$D1_DATABASE_ID" | grep -Eq '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'; then
  echo "[deploy-prepare] D1_DATABASE_ID 看起來不像 Database ID：'$D1_DATABASE_ID'" >&2
  echo "  應該是一串 uuid（8-4-4-4-12 位十六進制），不是數據庫的名字。" >&2
  exit 1
fi

# 走臨時文件而不是 sed -i：BSD sed（macOS）的 -i 要帶參數，GNU sed 不用，
# 這個寫法兩邊都對——本地拿 macOS 試這個腳本時不會莫名其妙掛掉。
sed "s|$PLACEHOLDER|$D1_DATABASE_ID|" wrangler.toml > wrangler.toml.tmp
mv wrangler.toml.tmp wrangler.toml
echo "[deploy-prepare] 已把 D1 database_id 填進 wrangler.toml。"
