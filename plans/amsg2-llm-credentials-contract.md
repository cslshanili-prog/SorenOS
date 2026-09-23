# LLM 憑據引用（credRefs）實施契約（給施工 agent）

上游（ReiStandard / `@rei-standard/amsg-server` 等）的改動契約。SullyOS 側接入是後續另一輪，
文末留檔，本輪不做。

**基線**：ReiStandard 倉庫 `feat/amsg-llm-credentials` 分支（自 origin/main `784a295` 切出，
server 2.6.0-next.16）。文中行號是探查時（next.15 工作區）的參考值，以當前代碼為準。

## 動機（一段話）

現狀是每條任務的 `encrypted_payload` 裡各凍結一份 `apiUrl / apiKey / primaryModel`：
換 Key 要把待觸發任務逐條 PUT 回去（漏一條到點就 401）；角色在 fire 裡自排的任務從
「正在跑的那一條」複製憑據，客戶端夠不著，舊 Key 順著自排鏈無限傳；每往任務裡塞一類
新用途的憑據（如情緒評估的副 API 隨 metadata 走），就要再手寫一套防洩漏防線。
改法：憑據集中存一張表，任務只帶**引用**。先例是 `push_subscriptions`——同一倉庫裡
「逐任務凍結 → 用戶級一行 + legacyFallback 平滑遷移」的完整樣板
（建表註釋、`resolvePushSubscription` 的 `legacyFallback`、`update-message` 拒收舊寫法，
都照它的思路抄）。

## 1. 新表 `llm_credentials`

```sql
CREATE TABLE IF NOT EXISTS llm_credentials (
  user_id TEXT NOT NULL,
  cred_id TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, cred_id)
);
```

- 適配器覆蓋面**對齊 `push_subscriptions`**：`schema.sqlite.js`、`schema.js`（Postgres）、
  `examples/cloudflare-single-user/schema.sql`、`SQLITE_MIGRATIONS` 數組 +
  `POST /init-tenant` 冪等執行，一處不落。
- `encrypted_value` = `encryptForStorage(JSON.stringify(value), userKey)`，
  與 `encrypted_payload` 同一把 per-user 派生密鑰。**紅線：必須加密存**。
  （client_state 裡 tool_config 明文存是歷史欠帳，不許照它。）
- `value` 形狀：`{ apiUrl, apiKey, primaryModel }` 三字段全必填。校驗口徑對齊
  `update-message`：只查 truthy，不做格式校驗。
- `cred_id`：**不透明字符串**，上游不解釋語義。校驗：非空、≤128 字符、不含控制字符。
  命名約定寫進文檔但不強制：`char:<charId>/<purpose>`、`global/<purpose>`。

## 2. HTTP 端點 `/llm-credentials`

掛 single-user worker 路由，鑑權同現有端點（設了 `AMSG_SERVER_TOKEN` 就要求
`X-Client-Token` 常時比較；`X-User-Id` 必須 UUID v4）。請求體加解密方式對齊
`PUT /client-state`（客戶端預加密信封，服務端解開；handler 抄現有解信封的模式）。

| 方法 | 語義 | 體（信封內） | 響應 |
|---|---|---|---|
| PUT | 批量 upsert | `{ credentials: [{ credId, value }] }` | `{ upserted: n }` |
| GET | 對帳清單 | — | `{ credentials: [{ credId, updatedAt }] }` |
| DELETE | 刪除 | `{ credIds: [...] }` 或 `{ all: true }` | `{ deleted: n }` |

- **GET 永不回 value**——一個字段都不回，對齊 task-projection 白名單哲學。
- PUT upsert 要刷 `updated_at`；GET 排序按 `cred_id` 穩定輸出。

## 3. `POST /schedule-message`：新字段 `credRefs`

- payload 頂層可選 `credRefs: Record<string, string>`（purpose → credId）。
  校驗：purpose 鍵 ≤64 字符、條目 ≤16、值符合 cred_id 規則。
- 必填校驗（`validation.js`）改為：
  - `prompted` / `auto`：prompt +（`credRefs.chat` 存在 **或** 內聯三件套齊全），
    **兩者都傳 → 400 `INVALID_PARAMETERS`**（新 API 沒有存量調用方，不留歧義）。
  - `instant`：`userMessage` 或（`credRefs.chat` / 內聯三件套），同樣不許兩者都傳。
  - `fixed`：`credRefs` 允許攜帶（hook 場景可能用別的 purpose），不參與必填判定。
- **存在性檢查**：排程時對 `credRefs` 裡**全部** credId 做一次 IN 查詢，缺的回 4xx
  `CREDENTIAL_NOT_FOUND` 並點名缺哪個（先例：schedule-message 建任務前檢查
  push 訂閱存在性那段）。檢查後被 DELETE 掉屬 TOCTOU 競態，由 fire 時兜底（§5）。
- `credRefs` 原樣存進 `encrypted_payload`（`fullTaskData` 白名單加一項）。

## 4. `PUT /update-message`

- 接受 `credRefs` 更新：**整體替換**（語義同 metadata），同樣做存在性檢查。
- 內聯三件套的 truthy-spread 更新照舊——存量任務還靠它續命。
- 傳了 `credRefs` 不去動存量內聯三件套（留作 fire 時兜底，見 §5）。

## 5. fire 時的解析（讀取側）

- 解析順序：`credRefs.chat` 有 → 查表取值；查不到行 → 退回內聯三件套（如有）；
  都沒有 → 本輪失敗，`last_error` 記 `CREDENTIAL_MISSING`，走常規重試語義
  （用戶補傳憑據後下一輪自愈）。
- 解析發生在 `callLlm` 的調用點（`message-processor.js` 的 instant / prompted-auto
  兩處 + `agentic-fire.js` 的 agentic 循環），把取到的三件套只合進**傳給 callLlm
  的請求對象**。**紅線：不許把解析結果寫回** `decryptedPayload` / `buildHookTask`
  產物 / ctx / metadata——任何會流向 hook 或 push 的對象都不行，否則
  `CREDENTIAL_PAYLOAD_KEYS` 那道防線等於白搭。`shared/llm-call.js` 不動。
- `taskNeedsLlm()` 判據更新：`!!(credRefs?.chat)` 或內聯三件套齊。
- `ctx.scheduleTask()`（自排）：父任務有 `credRefs` → **複製引用**（不是解析後的值），
  不復制內聯；父任務是存量內聯 → 照今天複製內聯。
  這是本次改動要釘死的核心行為：自排鏈傳引用之後，換 Key 自動跟隨。

## 6. hook 能力：`ctx.resolveLlmCredential(credId)`

- fire hook 的 ctx 新增方法：`resolveLlmCredential(credId): Promise<{ apiUrl, apiKey,
  primaryModel } | null>`，查不到回 null。
- 每次調用返回新對象。文檔紅線：hook 拿到就用，**不得**把結果掛到 ctx / task /
  metadata / push 上。宿主 hook（如情緒評估）以後用它取副 API，憑據自此不再隨
  metadata 走。
- `CREDENTIAL_PAYLOAD_KEYS` 不動（護的是存量內聯）。`credRefs` 本身不是機密：
  不加入屏蔽集，且 **task-projection 白名單加上它**（客戶端對帳要看）。

## 7. 限額與錯誤碼彙總

| 項 | 值 |
|---|---|
| cred_id 長度 | 1–128，無控制字符 |
| value 單字段長度 | ≤2048 |
| PUT 單批 | ≤100 條 |
| 單用戶總行數 | ≤500 |
| credRefs 條目 | ≤16，purpose 鍵 ≤64 |
| 引用不存在（排程/更新時） | 4xx `CREDENTIAL_NOT_FOUND`，點名 credId |
| fire 時解析不到且無內聯 | `last_error: CREDENTIAL_MISSING`，常規重試 |
| 形狀/超限 | 複用現有 `INVALID_PARAMETERS` / LIMIT 類錯誤碼風格 |

## 8. 兼容與遷移

- 存量任務**不遷移**：內聯三件套繼續工作到任務自然消亡（legacyFallback，
  先例同 push 訂閱）。憑據鎖在 per-user key 加密的 payload JSON 裡，沒有批量
  解密重寫的路徑，也不要造——將來有需要由客戶端逐條按需做。
- `amsg-client` SDK 新增：`putLlmCredentials` / `listLlmCredentials` /
  `deleteLlmCredentials`；`scheduleMessage` / `updateMessage` 參數透傳 `credRefs`。
  信封加密複用現有封裝。

## 9. 測試（迴歸守衛，每條都要能在舊行為下掛、修好後過）

1. 端點：PUT/GET/DELETE 加密往返；GET 響應裡摸不到 apiKey/apiUrl/primaryModel。
2. 排程：只帶 `credRefs.chat` 能建 prompted/auto 任務；credRefs 與內聯同傳被拒；
   引用不存在被拒且點名。
3. fire：credRefs 解析成功調到 LLM（mock 斷言請求頭/模型來自表裡的值）；
   行刪掉後退回內聯；都沒有 → `CREDENTIAL_MISSING` + 重試語義。
4. **自排鏈跟隨換 Key（靈魂測試）**：父任務帶 credRefs → 自排出的子任務複製的是
   引用；改表裡的值後，子任務 fire 用的是新值。
5. 洩漏防線：hookTask / push payload 裡摸不到解析後的 apiKey。
6. update-message：credRefs 整體替換 + 存在性檢查。
7. schema 一致性：examples 的 schema.sql 與 SQLITE_MIGRATIONS 建出來的表一致
   （有現成的一致性測試就跟著加）。

## 10. 文檔與發版

- 更新相關包 README / API 文檔：端點、payload 字段、hook API、cred_id 命名約定、
  與內聯三件套的關係（平鋪直敘「這是啥 / 啥時候用」，不寫糾錯腔、不踩舊寫法）。
- changeset：server minor、client minor（當前 pre 模式 `next`，**只加 changeset
  文件**，不跑 `changeset version` / `changeset publish`）。

## 11. 施工邊界（紅線）

- 只許改 `/Users/tntobsidian/Documents/GitHub/ReiStandard` 內的文件。
- **禁一切 git 寫操作**（commit / push / reset / switch / stash / rebase…）；
  分支已由主線程切好，改動留在工作區待審。git 只讀命令（status / diff / log）隨意。
- 包管理器用 **npm**（ReiStandard 是 npm workspaces + package-lock；pnpm 是
  SullyOS 的規矩，別帶過去）。依賴沒裝就 `npm install`。
- 不動 `shared/llm-call.js`、不動加密原語、不動與本契約無關的行為。
- 驗證：至少跑 server 包的 build + test（`npm run build` / `npm test`，或根目錄
  `npm run ci`），結果如實報告，失敗不許粉飾。

## 修訂（2026-08-10）：credRefs 繼承與空憑據語義

首版實現按「有 credRefs 就只複製引用」處理自排繼承，沒有覆蓋「credRefs 只帶非 chat
purpose」的組合，會產出既無引用可解析、又無內聯憑據的空殼後代並靜默不生成。修訂後
的語義：

- `ctx.scheduleTask()` 的憑據繼承按 **`credRefs.chat`** 分支：父任務帶 chat 引用 →
  複製整份 credRefs、內聯置空；父任務只帶非 chat 引用（如僅 emotion）→ credRefs 與
  內聯三件套**都**複製——引用歸 hook 用途，內聯管聊天。
- `prompted` / `auto` 任務 fire 時既無 `credRefs.chat` 也無內聯三件套 → 按
  `CREDENTIAL_MISSING` 失敗進常規重試，不許靜默判成「不需要 LLM」。`instant` 保持
  「無憑據 = 純推送」的路由語義不變。
- 校驗口徑：`credRefs.chat` 與內聯三件套**任一字段**同傳 → 400（不是三件齊全才拒）；
  僅含非 chat purpose 的 credRefs 與內聯三件套共存是合法組合。
- 文檔裡提可用性門檻時引用 capabilities feature `'llm-credentials'`，不寫死版本號
  （實際發版號與預估不同步是常態）。

## SullyOS 側落地（2026-08-10 完成）

- 憑據行**每角色三份**（比上文約定多一份，原因見下）：`char:<id>/chat`（排程任務，
  開了角色單獨 API 就是那一份，否則是全局 API 的拷貝）、`char:<id>/instant`（即時
  對話，值是當輪請求的終值——含開思考時拼出的 `-thinking` 模型名，每輪指紋門控覆蓋，
  值沒變零請求）、`char:<id>/emotion`（情緒評估，`emotionConfig.api` 缺省時回落全局
  API）。拆開 chat / instant 是因為即時對話固定走全局 API、排程可走角色單獨 API，
  共用一行會讓開單獨 API 的角色被靜默換模型。
- 構建與命名住 `utils/amsgLlmCredentials.ts`；上雲的指紋門控、退避、底帳在
  `utils/amsgStateSync.ts`（與 tool_config 同款）；排程 / 即時對話帶 `credRefs` 與
  `CREDENTIAL_NOT_FOUND` 當場補傳自愈在 `utils/activeMsgClient.ts`。
- 門檻只一處：`isLlmCredentialsReady()` 判 capabilities 含 `'llm-credentials'`，
  不達標原樣走內聯老路（舊 Worker 只是用不上新路，不會壞）。
- 情緒評估新任務的 `metadata.amsgEmotionEval` 只剩 `{ prompt }`，憑據走
  `credRefs.emotion`；存量任務 metadata 裡的 `api` 繼續認，兩道 strip 防線保留到
  存量消亡。
- `emotion` 行是懶創建的：第一次跑「帶情緒評估的即時對話」時才隨指紋門控 PUT 上表，
  在那之前表裡只有 `chat` / `instant` 兩行——排查時見不到 `emotion` 行屬正常，
  不代表沒實現。
- 「清空雲端數據」第四樣 `deleteLlmCredentials({ all: true })`，與前三樣互不短路。
- 補刷函數（`refreshCharPendingAiTaskCredentials` / `refreshApiCredentialsForPendingTasks`）
  混合期保留照跑，存量內聯任務消亡後自然 no-op，屆時可退役，「API 憑據沒刷新成功」
  toast 一併消失。
