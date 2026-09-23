#!/usr/bin/env bash
# /opt/umami/bin/audit-entry.sh
#
# GitHub Actions 那把審計鑰匙唯一能觸達的東西。
#
# 鏈路：
#   CI: ssh audit@stats.friedsully.com "<GITHUB_RUN_ID>"
#   → authorized_keys 裡的 restrict,command= 把請求的命令整個丟掉，
#     原文塞進 SSH_ORIGINAL_COMMAND，然後無條件執行本腳本
#   → sudoers 只允許 audit 免密跑這一個腳本（audit 自己沒有 docker 權限、
#     不在任何特權組，拿到它的 shell 也做不了什麼）
#   → 本腳本校驗 nonce，轉交 assert-privacy.sh
#
# ⚠️ SSH_ORIGINAL_COMMAND 的內容 100% 由客戶端控制，而且這裡是 root 上下文。
# 鑰匙洩露的場景下，這個變量就是攻擊者手上唯一的輸入 —— 它下游會被拼進
# SQL 字符串（事件名 ci_probe_<nonce>）。所以下面三道校驗一道都不能省，
# 也不要"順手"改成接受連字符、字母或者別的什麼格式再說。
# 想傳別的參數進來的話，正確做法是在這裡新增一個固定的、不含用戶輸入的分支。

set -uo pipefail
umask 077

log() { printf '%s\n' "$*" >&2; }

reject() {
  log "拒絕：$1"
  logger -t umami-audit -p user.warning "審計入口拒絕請求：$1（原文長度 ${#raw}）"
  exit 2
}

raw="${SSH_ORIGINAL_COMMAND:-}"

# ── 校驗 1：長度。先卡長度，避免把超長垃圾餵給後面的匹配和日誌。
(( ${#raw} >= 1 && ${#raw} <= 24 )) || reject "長度不合法"

# ── 校驗 2：case 通配。含任意一個非 0-9 的字符（包括換行、空格、引號、
#    分號、反引號）就出局。這條比正則更不容易出岔子：它逐字符看整個字符串，
#    不涉及任何錨定語義。
case "$raw" in
  ''|*[!0-9]*) reject "含非數字字符" ;;
esac

# ── 校驗 3：正則複核。bash 的 =~ 裡 ^ $ 錨定的是整個字符串而不是行，
#    和上面那條是互相獨立的兩種實現，一起用是故意的。
[[ "$raw" =~ ^[0-9]+$ ]] || reject "正則複核未通過"

nonce="$raw"
logger -t umami-audit -p user.info "審計入口接受 nonce=$nonce"

echo "===== AUDIT-BEGIN nonce=$nonce $(date -u +%FT%TZ) ====="

/opt/umami/bin/assert-privacy.sh "$nonce"
rc=$?

echo "===== AUDIT-END rc=$rc ====="

# ── schema 帳本（第三檔）。只輸出，不判斷。CI 那邊拿它和倉庫裡存的
#    infra/umami-schema.sql 比一下，不一樣就把 diff 報出來讓人看。
#    刻意不讓 CI 自己 commit 回倉庫：master 要求走 PR，bot 直推會被規則彈回來，
#    而且帳本留在 Actions 歷史裡（90 天）目前就夠用了。
#
#    那兩條 grep 不是潔癖：pg_dump 17 會在開頭插一行
#      \restrict <每次都不同的隨機 token>
#    （17.6 引入，防 psql 元命令注入）。不濾掉的話每天的 dump 都不一樣，
#    第三檔就變成每天往倉庫灌一次無意義的 commit —— 正是不想要的那個結果。
#    除此之外 pg_dump 的輸出不含時間戳，所以濾完之後 schema 沒動的日子
#    是逐字節相同的。
echo "===== SCHEMA-BEGIN ====="
docker compose -f /opt/umami/docker-compose.yml exec -T db \
  pg_dump -U umami -d umami --schema-only --no-owner --no-privileges < /dev/null \
  | grep -v '^\\restrict ' | grep -v '^\\unrestrict '
echo "===== SCHEMA-END ====="

exit "$rc"
