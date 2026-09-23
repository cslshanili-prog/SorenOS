# 交接 prompt：給 amsg-server 單用戶/cloudflare 路徑加「滿血後台消息」支持

> 這份是給在 **ReiStandard** 倉庫（`packages/rei-standard-amsg/server`）裡幹活的實例看的，自包含，
> 不依賴別處上下文。目標：讓單用戶 / Cloudflare（`@rei-standard/amsg-server/cloudflare`）部署的
> worker 在定時任務觸發時，能夠 **現場組裝 prompt + 在服務端跑多輪工具循環**，而不是只會
> 「取出排程時凍結的 completePrompt → 一次 LLM → 推送」。
>
> 三個交付物：① `client_state` 通用狀態表 + 讀寫端點；② fire 時刻的 hook 契約；
> ③ 服務端 agentic 循環（對齊 amsg-instant 0.8 的 hook 形狀）。

## 背景（為什麼要改）

下游（SullyOS）的主動消息現在是：客戶端在**排程時**把完整 prompt 拼好，凍結進 D1 的任務裡；
cron 到點後 worker 拿凍結文本調一次 LLM 就推送。問題：

1. 上下文停留在排程那一刻——每週任務觸發時，prompt 裡的"最近聊天"可能是七天前的；
2. 完全沒有工具：LLM 不能查記憶、不能調 MCP，因為 fire 時刻客戶端多半不在線，
   而現有 amsg-instant 的工具模式（推 tool_request 回客戶端執行再 POST /continue）依賴客戶端活著。

目標形態：客戶端平時把狀態增量同步到 worker 的 D1（新表 `client_state`）；fire 時 worker
從狀態表現場組裝 prompt，需要工具時**在 worker 內直接執行**（host 提供執行器），多輪循環
全部在服務端閉環，最後推送成品。中途不需要客戶端參與。

## 前置約束（紅線，先讀）

- **通用抽象，不耦合任何具體應用**。amsg-server 是通用庫，本次新增的表、端點、hook 契約
  裡不得出現任何下游項目（含 SullyOS）的業務概念——不硬編碼業務標籤名、工具名、namespace
  命名規範。所有業務語義（輸出怎麼分類、工具怎麼執行、狀態裡存什麼）全部由宿主經 hooks
  注入，庫只提供循環骨架和存取通道。寫文檔舉例時用中性示例。
- **純 Web Crypto / 零 node 內置依賴**。這條路徑的主線部署方式是「複製 bundle 粘進
  Cloudflare Dashboard」，不開 `nodejs_compat`。此前已把 `lib/encryption.js` 等全部港到
  Web Crypto（見 encryption.js 頭註釋），**不要**在新代碼裡引 `node:crypto` / `Buffer` 等
  把免 flag 目標破壞掉。驗收裡有打包檢查。
- **向後兼容**。沒配新 hook 的既有部署（含已經粘貼上線的用戶 worker）行為必須一字不變：
  老任務照走凍結 prompt 的老鏈路。
- **hook 不暴露憑據**。學 amsg-instant `SessionContext` 的做法：hook 收到的 ctx 裡沒有
  `apiKey` / `pushSubscription` / VAPID，防止 hook 作者一句 `console.log(ctx)` 把密鑰打進日誌。

## 任務 1：`client_state` 表 + 讀寫端點

單用戶模式下客戶端狀態的雲端鏡像。一份活狀態（不按任務多份快照），按 namespace 組織，
客戶端是唯一寫者。

**表（init-tenant 冪等建表，跟現有建表走同一套 migration 機制）：**

```sql
CREATE TABLE IF NOT EXISTS client_state (
  user_id    TEXT NOT NULL,
  namespace  TEXT NOT NULL,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,          -- encryptForStorage 密文
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, namespace, key)
);
```

**端點（掛在單用戶 worker 的路由上，命名可按倉庫慣例調整）：**

| 端點 | 語義 |
|------|------|
| `PUT /client-state` | 批量 upsert。body = `{ entries: [{ namespace, key, value, updatedAt }] }`。服務端按 `updatedAt` 最後寫贏（舊於庫內的條目跳過），value 用現有 `encryptForStorage`（per-user key）落庫 |
| `GET /client-state?namespace=<ns>` | 取一個 namespace 的全部條目（解密後返回，響應走現有 payload 加密） |
| `DELETE /client-state` | 清空該 user 的全部狀態（下游設置頁的「清除雲端狀態」按鈕用） |

鑑權與加密全部沿用現狀：`X-Client-Token` 全端點 all-or-nothing 校驗、`X-User-Id`、
請求/響應加密頭（`X-Payload-Encrypted` 等）。CORS 同現有端點。

批量 upsert 是唯一寫入口——客戶端在 iOS 切後台前只有幾秒存活窗口，必須一次請求寫完，
所以 entries 數組要支持幾十條一批。單條 value 約束在 ~200KB（超限回 4xx 帶明確報錯）。

## 任務 2：fire 時刻的 hook 契約

`createSingleUserCloudflareWorker(...)`（或對應工廠）接受可選 hooks。建議形狀
（命名按倉庫慣例定，語義別變）：

```js
{
  hooks: {
    // fire 時組裝 prompt。返回 messages（或帶覆蓋項的對象）→ 走新鏈路；
    // 返回 null/undefined → 回退老鏈路（凍結 prompt）。
    // ctx: { task, userId, readState(namespace) => Promise<entries>, now }
    //   - task: 任務行（mode / promptHint / charId / contactName 等任務字段，密文已解）
    //   - readState: 讀 client_state 的能力句柄（內部已解密）
    // 返回值兩種形狀都接受：
    //   ChatMessage[]
    //   { messages: ChatMessage[], maxToolIterations?, totalTimeoutMs? }  ← 本次 fire 覆蓋工廠默認
    onBeforeFire(ctx) => Promise<ChatMessage[] | { messages, maxToolIterations?, totalTimeoutMs? } | null>,

    // 每輪 LLM 輸出後分類。與 amsg-instant 0.8 的 onLLMOutput 同構：
    // ctx = { sessionId, messages, llmResponse, llmOutputText, iteration, metadata, contactName, avatarUrl }
    // 返回 { decision: 'tool-request', toolCalls } | { decision: 'finish', pushPayloads } | { decision: 'skip-push' }
    onLLMOutput(ctx) => Promise<Decision>,

    // 服務端工具執行器（與 amsg-instant 的關鍵差異：不推 tool_request 回客戶端，就地執行）。
    // 返回 OpenAI tool-result 形狀：[{ tool_call_id, role: 'tool', content }]
    executeToolCalls(toolCalls, ctx) => Promise<ToolResult[]>,
  },
  maxToolIterations: 5,     // 工廠級默認，宿主可配；onBeforeFire 返回值可按次覆蓋
  totalTimeoutMs: 240_000,  // 整鏈 wall-time 兜底，同樣可配可按次覆蓋
}
```

循環由庫驅動（host 只寫業務）：

```
onBeforeFire → messages
  → callLLM → onLLMOutput
      ├─ 'finish'        → 推送 pushPayloads，寫 outbound log，完
      ├─ 'skip-push'     → 記錄後結束（沿用 amsg-instant 語義）
      └─ 'tool-request'  → executeToolCalls → messages 追加 assistant(toolCalls)+tool results
                           → iteration+1 → 回到 callLLM（≤ maxToolIterations）
```

實現提醒：

- **多輪循環的實現 amsg-instant 0.8 已經有一遍**（`/instant` + `/continue` 那套的服務端）。
  優先把可共用的部分（decision 處理、iteration 校驗、push 切分調度）抽到共享層複用，
  而不是在 amsg-server 裡再抄一份。怎麼抽（進 amsg-shared 還是 server 內部模塊）你定，
  contract 形狀對齊 amsg-instant 即可——下游要把 instant 的 classifier 原樣複用到這裡。
- LLM 調用複用現有 `callLlmRaw` 系（注意工具輪的響應可能沒有 content，
  `requireContent` 要放行這種情況，amsg-instant 已有先例）。
- cron `scheduled()` 裡等 LLM 是 IO 等待，不吃 CF 的 CPU 配額，但整鏈 wall-time 必須有
  總超時兜底（`totalTimeoutMs`，默認 240s），超時帶著已有內容強制 finish 或按失敗記錄，
  別讓 tick 懸死。**輪數與總超時都要工廠級可配 + fire 級可覆蓋**——宿主可能有明確更耗時的
  工具（長搜索、外部 API 慢路徑），由宿主在 onBeforeFire 裡按任務自行判斷放寬。
- 失敗語義沿用現有任務失敗處理（重試/標記），工具執行拋錯時把錯誤文本作為 tool result
  回填給 LLM 讓它自己圓場，而不是整條鏈失敗。

## 任務 3：run-tick / message-processor 接入

`lib/run-tick.js` → `lib/message-processor.js` 這條 fire 鏈裡：

- 任務是需要 LLM 生成的類型（非固定文本）且 host 配了 `onBeforeFire` → 走任務 2 的新鏈路；
- `onBeforeFire` 未配置、或返回 null → **老鏈路原樣**（取凍結 completePrompt 一次 LLM）。
  固定文本類任務永遠走老鏈路。

## 任務 4：測試

1. **向後兼容守衛**：不配 hooks 時，現有全部 server 測試原樣通過；一個 mode=auto 的任務
   走完老鏈路，行為與改動前一致（這條要能在「以後有人把老鏈路刪了」時掛掉）。
2. **新鏈路 happy path**：mock LLM，onBeforeFire 組裝 → 一輪 tool-request →
   executeToolCalls → 第二輪 finish → 斷言推送 payload 與 outbound log。
3. **輪數上限與覆蓋**：LLM 永遠返回 tool-request，斷言在 maxToolIterations 處強制收尾；
   onBeforeFire 返回覆蓋值時按覆蓋值收尾（totalTimeoutMs 覆蓋同理）。
4. **client_state**：批量 upsert（含 updatedAt 舊值跳過）→ GET 解密還原 → DELETE 清空；
   value 超限 4xx；未帶 token 401（all-or-nothing 生效）。
5. **憑據不洩露**：斷言傳給各 hook 的 ctx 上沒有 apiKey / pushSubscription / vapid 字段。

## 驗收標準（都過才算完）

1. cloudflare 入口仍能純 neutral 打包：
   ```bash
   npx esbuild worker.js --bundle --format=esm --target=es2022 \
     --platform=neutral --conditions=worker,browser,import,default --outfile=/tmp/amsg-neutral.js
   # 期望：exit 0，且 grep -c 'node:' /tmp/amsg-neutral.js 結果為 0
   ```
2. 全套 server 測試通過（含多租戶迴歸——共用文件的改動別把 Netlify 主入口弄炸）。
3. 不配 hooks 的部署行為與當前版本逐字節一致（老 completePrompt 鏈路）。
4. 新增代碼裡 grep 不到任何下游業務標識（業務標籤名 / 具體應用名），hook 契約文檔的示例
   全部是中性示例。
5. 版本 +1、發 next tag（當前 npm `@rei-standard/amsg-server` 的 next = 2.6.0-next.2，
   本次往上發），`exports` 的 `./cloudflare` 子路徑不變。README/JSDoc 給 hooks 一段
   「這是啥 / 啥時候用」說明。

## 交付後（SullyOS 下游收口，不用你管，僅供瞭解）

下游會：升 devDep 重打 `worker/amsg` bundle → wrapper 裡配 hooks（onLLMOutput 複用
instant-push 的業務標籤 classifier；executeToolCalls 按工具名分發到 recall/Supabase 查詢、
MCP mini client、web_search 等 adapter）→ 前端加狀態同步層（髒標記 + 切後台批量 upsert
client_state）→ 設置頁加「清除雲端狀態」。你這邊只要保證 hook 契約、client_state 端點和
免 flag 打包三件事穩定即可。
