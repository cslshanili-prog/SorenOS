# infra/ — 統計服務器的配置基線

這裡放的是自託管 umami 實例（`stats.friedsully.com`）上那幾個**決定隱私承諾成不成立**的文件的副本。
它們不參與前端構建，只有一個用途：給 [`.github/workflows/privacy-audit.yml`](../.github/workflows/privacy-audit.yml)
當比對基線。

承諾本身寫在 [`docs/analytics.md`](../docs/analytics.md)，這裡是「怎麼保證它沒被悄悄改掉」。

| 文件 | 線上位置 | 說明 |
|---|---|---|
| `Caddyfile` | `/etc/caddy/Caddyfile` | IP 截斷（v4 → /24、v6 → /48）、清掉十幾個可偽造的真實-IP 頭和 CDN 地理頭、日誌全部 discard |
| `docker-compose.yml` | `/opt/umami/docker-compose.yml` | `PRIVATE_MODE` / `DISABLE_TELEMETRY` / `DISABLE_UPDATES`、`CLIENT_IP_HEADER=X-Anon-IP`、db 服務下**沒有** `ports:` |
| `assert-privacy.sh` | `/opt/umami/bin/assert-privacy.sh` | 每日自檢本體，把承諾逐條變成 SQL / HTTP 斷言 |
| `audit-entry.sh` | `/opt/umami/bin/audit-entry.sh` | CI 那把鑰匙唯一能觸達的入口，只收一個數字 nonce |
| `umami-privacy-trigger.expected.txt` | 數據庫裡 | geo 觸發器的規範化定義（postgres 自己吐的，不是手寫 SQL） |
| `umami-schema.sql` | 數據庫裡 | `pg_dump --schema-only` 的帳本，schema 變了 CI 會報 diff（不自動提交，見下） |
| `known_hosts` | — | 服務器主機指紋，釘死用的 |

## 判定為什麼放在倉庫這邊

服務器只做一件事：報出自己那幾個文件的 sha256（`assert-privacy.sh` 輸出的 `CONFIG-SHA256` 行）。
**比對發生在 GitHub Actions 裡**，基線是這個目錄。

這樣安排是因為，讓服務器自己判斷「我有沒有被改過」是沒有意義的 —— 能改配置的人當然也能改那個判斷。
拆成兩邊之後，想讓一次配置漂移不被發現，就得同時改服務器和這個倉庫，而這兩處留下的痕跡是分開的、
且倉庫那份有 git 歷史。

同理，`assert-privacy.sh` 裡那幾行 `CONFIG-SHA256` 不是防篡改措施，只是「報事實」。

## 改了線上配置怎麼辦

**先改線上，再把文件同步到這裡，一起提交。** 順序反過來也行，但兩邊必須在同一天對上 ——
CI 每天比一次，對不上就是紅的，而紅的原因只會寫「線上 X 與倉庫副本不一致」，
不會告訴你哪邊才是對的那個。所以 commit message 裡寫清楚改了什麼、為什麼。

`umami-privacy-trigger.expected.txt` 不要手寫，用數據庫的輸出：

```bash
docker compose -f /opt/umami/docker-compose.yml exec -T db psql -U umami -d umami -qtAX \
  -c "SELECT pg_get_functiondef('umami_strip_geo'::regproc);" < /dev/null
docker compose -f /opt/umami/docker-compose.yml exec -T db psql -U umami -d umami -qtAX \
  -c "SELECT pg_get_triggerdef(oid) FROM pg_trigger
      WHERE tgname='trg_umami_strip_geo' AND NOT tgisinternal;" < /dev/null
```

（兩條輸出拼起來、刪空行。手寫的 SQL 和 postgres 回吐的定義在空白和 schema 限定上對不上，逐字比對必然失敗。）

`umami-schema.sql` 平時不用管。schema 一旦變了（umami 升級加了表 / 加了列之類），
CI 會紅一次，並在 run summary 裡貼出 diff —— **新增的表和列正是「多了個能存敏感數據的地方」
最可能的樣子**，所以這裡刻意讓它紅而不是靜默通過。

確認無害之後，從那次 run 的 `umami-schema` artifact 裡把新版下下來，覆蓋 `infra/umami-schema.sql`
提交一次，下一輪就恢復綠。

CI 不會自己提交這個文件：master 要求走 PR，bot 直推會被分支保護彈回來（GH013），
而且紅的原因會變成「推不上去」這種跟隱私毫無關係的東西。帳本留在 artifact（90 天）
和 Actions 歷史裡，目前夠用。

## 換服務器 / 換域名了

重新生成 `known_hosts`：

```bash
ssh-keyscan -t ed25519,rsa,ecdsa <新域名> | sort > infra/known_hosts
```

審計鑰匙也要重來一把（`ssh-keygen -t ed25519`，私鑰進倉庫 secret `AUDIT_SSH_KEY`，
公鑰進服務器 `audit` 用戶的 `authorized_keys`，前綴是
`restrict,command="/usr/bin/sudo -n /opt/umami/bin/audit-entry.sh"`）。
別拿任何一把已有的登錄鑰匙來湊。
