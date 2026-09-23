# 彼方虛擬郵局 · 後端 Worker

跨用戶漂流信的**共享後端**（Cloudflare Worker + D1）。所有用戶共用同一個實例，
其他用戶無需任何配置。匿名：客戶端只帶一個隨機 `deviceId`（owner_id），無登錄、無 PII。

## 部署

```bash
cd worker/post-office
wrangler d1 create sullyos-post-office          # 拿到 database_id
# 把 database_id 填到 wrangler.toml 的 [[d1_databases]]
wrangler secret put ADMIN_TOKEN                 # 管理員令牌（刪信用）
wrangler secret put PO_IP_SALT                  # 限流哈希鹽（隨便一串長隨機值）
wrangler deploy
```

表結構由 Worker 自動建，**加性升級、不破壞老數據**（老庫會自動補 `likes/dislikes/views` 列、
新建 `po_devices/po_votes/po_ratelimit`），不必手動跑 `schema.sql`。

### 掛到統一域名（如 noir2.cc.cd/po）

二選一：

- **A. 單獨部署 + 路由**：部署本 worker，然後在 Cloudflare 給 `noir2.cc.cd/po/*`
  加一條 Route 指向它。客戶端默認就是 `https://noir2.cc.cd/po`。
- **B. 合併進現有 worker**：把 `src/index.ts` 的 `fetch` 邏輯並進你現有的 noir2
  worker（按 path 結尾匹配，和現有 push 路由不衝突），並綁定 D1 `DB`。

客戶端後端地址可在「彼方 → 郵局 → ⚙」裡改（默認 `https://noir2.cc.cd/po`）。

## 接口

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET  | `/health` | 健康檢查（含是否配置了管理員） |
| POST | `/letters` | `{device, letters:[{pen,content,lang?}]}` 上傳待寄出的信 |
| GET  | `/inbox?device=X&limit=N` | 隨機抽 N 封"別人的、還能回"的信（標記已抽避免重複；抽到即 +1 瀏覽量） |
| POST | `/vote` | `{device, letterId, vote: 1\|-1\|0}` 點贊 / 點踩(=舉報) / 撤銷 |
| POST | `/replies` | `{device, replies:[{letterId,pen,content}]}` 上傳回信（每封信最多 `PO_MAX_REPLIES` 個設備能回） |
| GET  | `/replies?device=X` | 取回"我寄出的信"上的回覆 + 各信的贊/踩/瀏覽量 |
| POST | `/release` | `{device, letterIds:[...]}` 作者刪自己的信（連同回覆/抽取/投票） |
| GET  | `/admin/list?token=&limit=` | **[管理]** 列信（按點踩降序），找要刪的 id |
| POST | `/admin/delete` | **[管理]** `{letterId}` 或 `{letterIds:[...]}`，刪信 |

管理接口憑 `ADMIN_TOKEN`：`Authorization: Bearer <token>` 或 `?token=<token>`。未配置則一律 401/503。

## 互動與防護

- **點贊 / 點踩**：一台設備對一封信只能一票（可改可撤）。**點踩即舉報**，不另設舉報。
- **自動刪除**：一封信點踩數達 `PO_DISLIKE_LIMIT`（默認 5）即被刪除（硬刪，不可恢復）。
- **正文上限**：每條信/回信正文上限 **400 字**（按字符，1 漢字/標點=1 字），超出截斷。
- **限流**：按客戶端 IP 的加鹽哈希做固定窗口限流，不存原始 IP——
  **投信：每 IP 每 5 小時 5 條**；回信/投票：每分鐘（可調）。
- **不按時間刪**：已移除舊的 TTL 自動清理。信只在 ①點踩滿 ②管理員刪 ③作者刪 時消失。

## 環境變量

| 名字 | 類型 | 默認 | 說明 |
|---|---|---|---|
| `PO_MAX_REPLIES` | var | 3 | 一封信最多被幾個設備回信 |
| `PO_DISLIKE_LIMIT` | var | 5 | 點踩(=舉報)數達此值即自動刪信 |
| `PO_RATE_LETTERS` | var | 5 | 每 IP 每 **5 小時** 投信上限 |
| `PO_RATE_REPLIES` | var | 60 | 每 IP 每分鐘回信上限 |
| `PO_RATE_VOTES` | var | 120 | 每 IP 每分鐘投票上限 |

> 正文上限固定 **400 字**（按字符，1 漢字/標點=1 字），寫死在 `src/index.ts`（`MAX_CONTENT`）。
| `ADMIN_TOKEN` | secret | — | 管理員令牌；未配置則 /admin/* 關閉 |
| `PO_IP_SALT` | secret | — | 限流哈希鹽；不可逆化 IP，建議配置 |

## 信件生命週期

```
待發送(本地草稿) ─[一鍵寄出]→ POST /letters → 公共池
   其他用戶 ─[刷新收件箱]→ GET /inbox（隨機抽，非自己的，+1 瀏覽量）
            ├─[點贊/點踩]→ POST /vote（點踩滿 PO_DISLIKE_LIMIT 自動刪）
            └─[回信]→ POST /replies（掛到該信）
作者 ─[收取回復/看熱度]→ GET /replies → 落本地留檔 ─→ POST /release（刪自己的信）
   管理員 ─[巡查]→ GET /admin/list ─[下架]→ POST /admin/delete
```

## 空間優化

`po_devices` 把長 `owner_id`(UUID) 映射成短整數 `uid`；多行的投票表 `po_votes` 只存 `uid`，
避免反覆存 36 字節的 UUID 字符串。對外 API 仍只認 `owner_id`，客戶端無感知。
