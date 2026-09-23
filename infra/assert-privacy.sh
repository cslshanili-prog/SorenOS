#!/usr/bin/env bash
# /opt/umami/bin/assert-privacy.sh
#
# 把公開承諾變成可執行斷言。任何一條不成立就退出碼非零，並在
# /opt/umami/ALERT.txt 留下現場 + 往 journal 打 err 級日誌。
#
# 被 backup.sh（每天）和 snapshot.sh（每月）無參調用 —— 每天跑意味著
# 觸發器哪天被 prisma 遷移沖掉，24 小時內就會暴露，而不是等下次快照。
#
# 也被 audit-entry.sh 帶一個 nonce 調用（GitHub Actions 每日外部審計）。
# 帶 nonce 時多跑一組「髒頭探針」斷言：CI 事先用偽造的 XFF / CF-IPCity 發了
# 一個事件，這裡驗證它確實落庫了（管道是活的）、而偽造值一個都沒滲進去
# （Caddy 清頭 + CLIENT_IP_HEADER 在行為上真的成立，不只是配置文件長得對）。
#
# 這份文件在倉庫裡有一份副本 infra/assert-privacy.sh，CI 每天比對兩者的
# sha256。注意下面自己輸出的 CONFIG-SHA256 不是防篡改措施 —— 能改這個腳本的人
# 當然也能改那幾行。真正的防線是「判定發生在倉庫那側」：服務器只負責報事實，
# 基線存在 GitHub 上，誰也沒法只動一邊。

set -Euo pipefail

COMPOSE=/opt/umami/docker-compose.yml
ALERT=/opt/umami/ALERT.txt
BASE_URL=https://stats.friedsully.com
RETENTION_MONTHS=12

# `< /dev/null` 不能省：docker compose exec 會讀 stdin，腳本一旦經 `bash -s`
# 之類的方式從標準輸入喂進來，psql 會把後半截腳本當查詢吞掉。
Q() { docker compose -f "$COMPOSE" exec -T db psql -U umami -d umami -qtAX -c "$1" < /dev/null; }

NONCE="${1:-}"

fails=()

check() { # check <描述> <期望值> <實際值>
  if [[ "$2" == "$3" ]]; then
    printf '  ✅ %-46s %s\n' "$1" "$3"
  else
    printf '  ❌ %-46s 期望 %s，實際 %s\n' "$1" "$2" "$3"
    fails+=("$1（期望 $2，實際 $3）")
  fi
}

echo "隱私不變量自檢 $(date -u +%FT%TZ)"
[[ -n "$NONCE" ]] && echo "（帶髒頭探針，nonce=$NONCE）"

# 1. geo 觸發器還在嗎（prisma 遷移最可能沖掉的就是它）
check "geo 觸發器存在" "1" \
  "$(Q "SELECT count(*) FROM pg_trigger WHERE tgname='trg_umami_strip_geo' AND NOT tgisinternal;")"

# 2. 觸發器真的在生效嗎 —— 這是承諾本身，不是承諾的實現細節
check "session.city 全為 NULL" "0" \
  "$(Q "SELECT count(*) FROM session WHERE city IS NOT NULL;")"
check "session.region 全為 NULL" "0" \
  "$(Q "SELECT count(*) FROM session WHERE region IS NOT NULL;")"

# 3. 有沒有誰加了 IP 列
check "全庫無 IP 類字段" "0" \
  "$(Q "SELECT count(*) FROM information_schema.columns
     WHERE table_schema='public' AND table_name <> 'analytics_snapshot'
       AND (column_name ~* '(^|_)ip(_|\$)' OR column_name ILIKE '%ip_address%' OR column_name ILIKE '%remote_addr%');")"

# 4. 約束 #6：錄製 / 熱圖 / pixel
check "無 website 開啟錄製" "0" \
  "$(Q "SELECT count(*) FROM website WHERE recorder_enabled;")"
check "session_replay 為空" "0" "$(Q "SELECT count(*) FROM session_replay;")"
check "heatmap_event 為空"  "0" "$(Q "SELECT count(*) FROM heatmap_event;")"
check "pixel 為空"          "0" "$(Q "SELECT count(*) FROM pixel;")"

# 5. 約束 #3：登錄沒被關掉
check "後台未登錄訪問被拒" "401" \
  "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 10 "$BASE_URL/api/websites" || echo ERR)"

# 6. 約束 #2：斷外聯的開關還在
cfg=$(curl -sS --max-time 10 "$BASE_URL/api/config" || echo '{}')
for k in privateMode telemetryDisabled updatesDisabled; do
  val=$(printf '%s' "$cfg" | python3 -c "import sys,json;print(str(json.load(sys.stdin).get(sys.argv[1],False)).lower())" "$k" 2>/dev/null || echo ERR)
  check "$k" "true" "$val"
done
check "tracker 腳本名未被改動" "null" \
  "$(printf '%s' "$cfg" | python3 -c "import sys,json;print(json.dumps(json.load(sys.stdin).get('trackerScriptName')))" 2>/dev/null || echo ERR)"

# 7. IP 頭處理：CLIENT_IP_HEADER 還指向 Caddy 注入的那個頭
check "CLIENT_IP_HEADER=X-Anon-IP" "X-Anon-IP" \
  "$(docker exec umami sh -c 'printf %s "$CLIENT_IP_HEADER"' 2>/dev/null || echo ERR)"

# 8. 約束 #4：5432 不對公網
check "宿主機無 5432 監聽" "0" "$(ss -lntH 2>/dev/null | grep -c ':5432 ' || true)"
check "compose 中 db 無 ports" "0" \
  "$(docker compose -f "$COMPOSE" config | awk '/^  db:/,/^  [a-z]+:$/' | grep -c 'ports:' || true)"

# 9. 反代不記 IP
check "Caddy 無 access log 文件" "0" \
  "$(find /var/log/caddy -type f 2>/dev/null | wc -l)"
check "Caddyfile 仍 discard 日誌" "2" \
  "$(grep -c 'output discard' /etc/caddy/Caddyfile || true)"
check "Caddyfile 仍做 IP 截斷" "1" \
  "$(grep -c 'header_up X-Anon-IP' /etc/caddy/Caddyfile || true)"

# 10. 約束：原始明細只留 12 個月
#
# 這條以前是漏的 —— 承諾寫在 docs/analytics.md 裡，執行它的 prune.sh 至今
# 還是草稿狀態（沒裝 timer），中間沒有任何東西在看著。現在它到期會自己紅。
oldest_over=$(Q "SELECT count(*) FROM website_event
                 WHERE created_at < now() - interval '$RETENTION_MONTHS months';")
check "無超過 ${RETENTION_MONTHS} 個月的原始明細" "0" "$oldest_over"
echo "     （最早一條明細：$(Q "SELECT coalesce(min(created_at)::date::text,'（無數據）') FROM website_event;")）"

# ───────────────────────────────────────────────────────────────────
# 11. 髒頭探針（只在帶 nonce 時跑）
#
# CI 在 SSH 進來之前，已經用一個瀏覽器 UA + 故意偽造的
# X-Forwarded-For / X-Real-IP / CF-IPCity / CF-IPCountry 發了一個事件。
# 這一組斷言回答的是「承諾在行為上成立嗎」，而不是「配置文件長得對嗎」：
#
#   a. 事件落庫      → 從公網到數據庫這條管道是活的，前面那些斷言查的是同一個庫
#   b. city/region 空 → 觸發器在真實寫入路徑上生效
#   c. country 不是偽造值、也不為空
#      → 偽造的 CF-IPCountry 沒被採信；且 country 能解析出來說明用的是
#        Caddy 截斷後的真實 IP。如果 XFF 被採信了，203.0.113.7 是 RFC5737
#        文檔地址，沒有地理歸屬，country 會是空 —— 空反而是出問題的信號。
# ───────────────────────────────────────────────────────────────────
probe_sids=""
if [[ -n "$NONCE" ]]; then
  ev="ci_probe_${NONCE}"
  echo
  echo "### 髒頭探針 $ev ###"

  # umami 的寫入不是同步的，給它一點時間，別把 CI 做成 flaky 的。
  n=0
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    n=$(Q "SELECT count(*) FROM website_event WHERE event_name = '$ev';")
    [[ "$n" =~ ^[0-9]+$ ]] && (( n > 0 )) && break
    sleep 2
  done

  check "探針事件已落庫" "1" "$( (( ${n:-0} > 0 )) && echo 1 || echo 0 )"

  if (( ${n:-0} > 0 )); then
    probe_sids=$(Q "SELECT string_agg(DISTINCT quote_literal(session_id), ',')
                    FROM website_event WHERE event_name = '$ev';")

    check "探針 session 的 city/region 為空" "0" \
      "$(Q "SELECT count(*) FROM session
            WHERE session_id IN ($probe_sids) AND (city IS NOT NULL OR region IS NOT NULL);")"

    check "偽造的地理頭未被採信" "0" \
      "$(Q "SELECT count(*) FROM session
            WHERE session_id IN ($probe_sids)
              AND (country = 'XX' OR country IS NULL OR country = '');")"

    check "探針未夾帶偽造 IP 串" "0" \
      "$(Q "SELECT count(*) FROM event_data
            WHERE string_value ILIKE '%203.0.113%' OR string_value ILIKE '%198.51.100%'
               OR string_value ILIKE '%Mordor%'    OR string_value ILIKE '%Shire%';")"

    echo "     （探針 session 實況：$(Q "SELECT 'country=' || coalesce(country,'∅') || ' city=' || coalesce(city,'∅') || ' region=' || coalesce(region,'∅') FROM session WHERE session_id IN ($probe_sids);" | paste -sd' ' -)）"
  fi
fi

# ───────────────────────────────────────────────────────────────────
# 12. 配置指紋。判定不在這裡 —— CI 拿倉庫 infra/ 裡的副本比對這幾行。
# ───────────────────────────────────────────────────────────────────
echo
echo "### 配置指紋 ###"
fp() { printf 'CONFIG-SHA256 %s %s\n' "$1" "$(sha256sum "$2" 2>/dev/null | awk '{print $1}')"; }
fp Caddyfile          /etc/caddy/Caddyfile
fp docker-compose.yml /opt/umami/docker-compose.yml
fp assert-privacy.sh  /opt/umami/bin/assert-privacy.sh
# audit-entry.sh 也必須釘住：它是 CI 那把鑰匙唯一能觸達的入口，
# 誰能改它誰就能讓下面這一切變成演出。
fp audit-entry.sh     /opt/umami/bin/audit-entry.sh
printf 'CONFIG-SHA256 %s %s\n' umami-privacy-trigger.expected.txt \
  "$({ Q "SELECT pg_get_functiondef('umami_strip_geo'::regproc);"
       Q "SELECT pg_get_triggerdef(oid) FROM pg_trigger
          WHERE tgname = 'trg_umami_strip_geo' AND NOT tgisinternal;"; } \
     | sed '/^$/d' | sha256sum | awk '{print $1}')"

# ───────────────────────────────────────────────────────────────────
# 13. 清理探針 —— 無論前面成敗都要清，別把審計產生的數據留在生產庫裡。
# ───────────────────────────────────────────────────────────────────
if [[ -n "$NONCE" && -n "$probe_sids" ]]; then
  ev="ci_probe_${NONCE}"
  Q "BEGIN;
     DELETE FROM event_data WHERE website_event_id IN
       (SELECT event_id FROM website_event WHERE event_name = '$ev');
     DELETE FROM website_event WHERE event_name = '$ev';
     DELETE FROM session_data WHERE session_id IN ($probe_sids);
     DELETE FROM session WHERE session_id IN ($probe_sids)
       AND NOT EXISTS (SELECT 1 FROM website_event we WHERE we.session_id = session.session_id);
     COMMIT;" > /dev/null
  left=$(Q "SELECT count(*) FROM website_event WHERE event_name = '$ev';")
  check "探針數據已清理" "0" "$left"
fi

echo
if (( ${#fails[@]} == 0 )); then
  echo "全部通過。"
  rm -f "$ALERT"
  exit 0
fi
{
  echo "===== 隱私不變量自檢失敗 $(date -u +%FT%TZ) ====="
  printf '%s\n' "${fails[@]}"
  echo
  echo "在修好之前，不要對外聲稱這些承諾仍然成立。"
} | tee "$ALERT"
logger -t umami-privacy -p user.err "隱私自檢失敗：${fails[*]}"
exit 1
