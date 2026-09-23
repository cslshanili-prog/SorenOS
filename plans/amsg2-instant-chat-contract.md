# instant chat 實施契約（給施工 agent）

設計動機與取捨見 [`amsg2-instant-chat.md`](./amsg2-instant-chat.md)，本文件是拍板後的實現契約：
端點形狀、數據格式、必須先驗證的上游行為、分工邊界。施工前先通讀兩份。

## 總體架構（定案）

- **不改上游 npm 包** `@rei-standard/*`（路由/D1/cron/推送都住在
  `node_modules/@rei-standard/amsg-server/dist/chunk-RRWCPPOY.mjs`，只讀參考，不動）。
  全部改動落在本倉庫：`worker/amsg/src/`（包裝層）、`utils/` 葉子模塊、前端。
- 防雙跑複用上游 `claimTask` 的 `lease_until` 條件更新；每分鐘 cron 是兜底撿漏者。
- 任務行型：`message_type = 'auto'` + `messageSubtype: 'instant-chat'`
  + `metadata: { amsgMode: 'instant', amsgInstantChat: true, charId }`。
  用 'auto' 是為了確定走 hooks + LLM 的 fire 管線；push 載荷的 `messageType`
  期望取自 `metadata.amsgMode`（見 V4），這樣客戶端收到的是
  `messageType: 'instant'`。`messageSubtype` 上游只當自由文本標籤原樣透傳，
  客戶端拿它做面板對帳的過濾判據：即時對話的行不補進任務清單（連同
  `status = 'failed'` 的行一起排除），否則用戶正等著的這一輪會顯示成待觸發的
  排程任務、還可能被「取消全部」順手掐掉。
- **durability 原則**：202 之前任務行必須已落 D1。`ctx.waitUntil` 只負責快，
  cron 負責穩。isolate 死了 → lease 過期 → cron 重跑，消息不丟。

## 新端點 `POST /instant-chat`（包裝層路由）

- 路由位置：`worker/amsg/src/index.ts` 的 default export，和 `/config-check`、
  `/debug` 同級（後綴匹配、OPTIONS 204、CORS 頭同現有約定，注意 `index.ts:1361`
  和上游 chunk `:3297` 的 CORS 允許頭兩處同步問題）。
- 鑑權：與上游一致——設了 `AMSG_SERVER_TOKEN` 就要求 `X-Client-Token` 常時比較；
  `X-User-Id` 必須 UUID v4。內部轉發的子請求帶全套頭，上游會再驗一次（上游是權威）。
- Body（明文 JSON 外殼，內含兩個客戶端預加密的信封）：

  ```jsonc
  {
    "statePayload": "<加密信封：即 PUT /client-state 的完整 body>",
    "taskPayload": "<加密信封：即 POST /schedule-message 的完整 body>"
  }
  ```

  taskPayload（信封內）固定帶 `immediate: true`（amsg-server 2.6.0-next.15 起：
  落庫即到期，不帶 `firstSendTime`）；頂替上一條時帶 `supersedesUuid`（上游在
  建新任務的同一事務裡取消舊的，原子）。外殼不再有明文 supersedesUuid。

- 處理步驟（嚴格順序，兩個 await 失敗即向客戶端返回明確錯誤，不落任務）：
  1. 內部 `upstream.fetch` 轉發 `PUT /client-state`（statePayload）→ 必須成功。
     HTTP ok 還不夠：上游按 updatedAt 條件寫（舊不蓋新），成功體 `data.skippedEntries`
     裡點名了 `fire_pack` 條目時同樣打回——`409 INSTANT_CHAT_STATE_STALE`，絕不落任務
     （否則 fire 拿舊 chat 段答話）。
     客戶端拿到這個碼會自愈一次：讀回雲端那幾行的 `updatedAt`、把本地水位抬過去
     （`utils/amsgStateClock.ts`）、重新蓋戳再發一次。設備時鐘只要領先過真實時間，雲端
     那一行就帶著一個還沒到的時刻，本地牆鍾從此跨不過去，那個角色發一句掛一句，把系統
     時間調回來也沒用；水位是這條路的唯一齣路。對齊不動才是真被別人寫了新的，那時不重發。
  2. 內部轉發 `POST /schedule-message`（taskPayload）→ 必須成功，拿到 uuid
     （頂替在上游事務內完成）。
  3. 返回 `202 { status: 'accepted', uuid }`。
  4. `ctx.waitUntil(upstream.scheduled(合成 event, env))` 立即觸發一次 tick，
     撿起剛落的行（與真 cron 併發時由 claim/lease 天然互斥）。
- `export default` 的 `fetch` / `scheduled` 簽名補上第三個參數 `ctx`
  （上游簽名只收兩個參數，多傳無害；`index.ts:1509-1510` 的註釋要同步改）。
- `/config-check` 的返回里加包裝層能力標誌（如 `instantChat: true`），設置頁
  用它做唯一版本門檻（開發期規矩：門檻只留一處，不做逐調用 capability 預檢）。

## 必須先驗證的上游行為（讀 chunk-RRWCPPOY.mjs，結論寫進報告）

| # | 驗證什麼 | 影響 |
|---|---------|------|
| V1 | `MIN_SCHEDULE_LEAD_MS`（chunk `:805`）是否約束 `/schedule-message` 的 `next_send_at`，即「立刻執行」的行能不能建 | 若約束 → 改為包裝層直插 D1（需查 `createTask` 對 `encrypted_payload` 的實際存儲格式，轉發方案作廢） |
| V2 | `message_type='auto'` 的行被 tick 撿起後 hooks（`onBeforeFire`/`runAgenticFire`）是否照常運行（`taskNeedsLlm` chunk `:819`） | 若不走 → 換行型或換觸發方式 |
| V3 | `upstream.scheduled(event, env)` 合成 event 需要哪些字段 | waitUntil 裡怎麼造 event |
| V4 | `buildScheduledPush`（`agentic.ts:381`）的 `messageType` 是否直接取 `metadata.amsgMode`，能否透出 `'instant'` | 客戶端按 messageType 分軌 |
| V5 | 前端 `encryptPayload`（`utils/activeMsgClient.ts:890`）產出的信封是否與 SDK 內部一致、可被上游解開 | 不行 → 退化為兩請求方案：SDK `putClientState` 先行 + `/instant-chat` 只帶 taskPayload（可接受，報告裡註明） |
| V6 | fire 鏈總超時（默認 5 輪/240s，chunk `:1070-1196`）能否經 `buildWorkerConfig` 配置，能否對 instant 任務單獨調大 | 目標 ≥600s（cron 牆鍾 15 分鐘內）；只能全局調就全局調到 600s，並把 lease 變長（totalTimeoutMs + 2min）的影響寫進報告 |

## fire_pack v7：`chat` 字段

- `AmsgFirePack`（`utils/amsgFirePack.ts`）增可選字段：

  ```ts
  chat?: {
    // 這一輪的 fullMessages（結構與本地生成走 /chat/completions 那份一致）。
    // chat.messages 不含前端時效段（時鐘/節日/天氣/熱搜/MCP 說明），這些由 worker
    // 在 fire 時刻的時效塊獨家供給。
    // content 允許結構化片段數組（圖片消息的 text + image_url），worker 只搬運不解釋；
    // 超出 client_state 單條預算時從最舊的消息開始把 image_url 降回文字段，
    // 最新一條用戶消息的圖片永不降級，仍超預算則整輪明確報錯。
    messages: { role: string; content: string | Array<{ type: string; [key: string]: unknown }> }[];
    builtAt: number;
  }
  ```

- `FIRE_PACK_VERSION` 6 → 7。開發期規矩：**不做舊格式兼容**，v6 包 parse 直接拒
  （現有定時任務的 fire_pack 會在下一輪 dirty-sync 時以 v7 重傳，無需遷移代碼）。
- `onBeforeFire`（`index.ts:791`）新增 instant 分支：`metadata.amsgInstantChat`
  為真時——
  - 用 `pack.chat.messages` 組請求消息（不走 `renderFirePack` 模板渲染），
    在末尾追加 system 塊注入時效內容：當前時間（沿用角色時區約定）、
    實時世界塊（`buildRealtimeWorldBlock`）。
  - **跳過**：presence gate、expire guard（`shouldExpireFire`）、
    task-instruction 檢查——這些是「主動消息到點還該不該發」的語義，對
    「用戶剛發消息等回覆」不適用。
  - **照常**：工具循環、表情包、後台 MCP、self_log、任務列表塊（角色平時聊天
    也能排未來消息，這個能力對話裡同樣要有）。
  - `pack.chat` 缺失而 metadata 標了 instant → 按失敗處理（防止拿主動消息模板
    錯答聊天）。

## push metadata 擴展字段

即時對話往返用到的 metadata 鍵，一併記在這（發側走加密信封，回程隨 push 明文 metadata）：

- 發側（任務 metadata，走加密信封）：`amsgEmotionEval`（評估模板 + 副 API 憑據；worker
  在 `onBeforeFire` 捕獲後就地刪除，餵給 push 構建前再剝一層——憑據絕不進任何 push/outbox）。
- 回程（push metadata）：`amsgEmotionUpdate` / `amsgEmotionDone` / `amsgEmotionError`
  （評估結果 / 熄燈信號 / 脫敏後的失敗原因）、`amsgReasoning`（思考鏈，只掛第一條 push、
  只在即時對話輪）、`amsgToolTrace`（`[{name,count}]`，只數真跑過的調用、只掛末條 push、
  只在即時對話輪）、`amsgUsage`（`{promptTokens, completionTokens}`，同樣只掛末條 push、
  只在即時對話輪）。
- `amsgUsage` 的去處：客戶端把它補進「設置 → API 調用記錄」裡那筆雲端調用（發出時先落
  一筆 pending，收到末條推送時回填 Token）。它是**最後一次**模型調用的用量——帶工具的
  一輪會連著調好幾次模型，中間幾次的數雲端沒留，所以跑過工具時那筆記錄會標「只算末輪」。
- 超限旁路：`amsgEmotionRef` / `amsgReasoningRef`（值挪進 client_state，鍵
  `emotion_update:<clientTaskId>` / `reasoning:<clientTaskId>`）。

## outbox（push 丟失的拉取兜底）

- 服務端 `message_outbox` 表（按用戶存，不分角色也不分消息類型）。每條 push 發出去
  **之前**先落一行，客戶端落庫之後 `POST /outbox/ack` 銷帳，所以「哪些還沒收下」是
  查得出來的事實，不用拿本地聊天記錄去猜。行的保留期跟著 Web Push TTL 上限（四周）走。
- 寫入點在庫層的 push 發送路徑上，定時主動消息和即時對話的產物都記。
- 客戶端拉帳本分兩類時機，別混：
  - **上線補收**（`catchUpMissedPushes`）：冷啟動、回到前台各一次，帶 60s 節流，
    **不看有沒有在等回覆**。定時主動消息由雲端到點自己發，客戶端不產生任何「我在等它」
    的本地狀態——只在等回覆時才拉的話，這類消息的推送丟了就永遠沒人去撈。
  - **等回覆時的點名**（`runInstantChatStatusCheck`）：每 60s 一跳，下結論前必拉一次
    最新的，不受節流管（拿舊帳本去判「回覆取不回」會誤殺還在路上的回覆）。
- 補收只上屏兩天內的條目，更老的只銷帳（那個歲數的推送推送服務早就不投了）。超窗銷掉
  幾條會數出來交給界面說一句——這一銷消息就永久拿不回來了，不能一聲不響。
- 頭一趟拉帳本走「存量整批銷帳、一條不上屏」（`adoptOutboxBacklog`）：worker 先更新
  建了表、前端還是老版本那段時間，帳本會攢下一批「其實收到了、只是不會銷帳」的行，
  當補收倒出來就是重放。用戶在設置頁手點的那次補收例外（`treatBacklogAsMissed`）——
  他是察覺到消息沒來才點的，這個判斷他自己做得了。

## 失敗路徑

- 客戶端「正在輸入」的主判定是**雲端任務狀態**：還欠著回覆時每 60s 查一次
  `GET /message?id=<uuid>`，`pending` 就繼續等，行已失敗 / 行沒了才收尾；
  查詢本身失敗不立刻下結論，等下一跳。下結論前先拉一次 outbox。
  **只在前台查**：頁面不可見時既不查也不排下一跳，回前台立刻點一次名把週期接上。
  **失聯判死線**：聯網狀態（`navigator.onLine !== false`）下同一輪連續 5 次查詢
  失敗 → worker 多半已不在（被刪 / 密鑰換了），明確收尾並提示去設置頁重新連接
  驗證；離線時的失敗不計數。「不按時長宣判」只對雲端還答得上話的等待成立。
- worker 留痕 `chat_fail`（char namespace 的 client_state，認 uuid）：fire 收尾
  失敗、過期跳過（reason `stale`）、以及 skip-push（reason `empty-generation` /
  `side-effects-only`——即時對話的一次性行會被上游當成功消費刪掉，客戶端只能看到
  gone）三處都寫。客戶端 completed 與 gone 兩個分支都點名讀回翻成人話，別把
  「沒生成出來」說成「回覆沒能取回」。
- worker 側若現有 hook（如 `onFireSettled`）拿得到失敗結局且拿得到 push 發送
  能力 → 盡力補發一條 `messageKind: 'error'`（SW 已有該分軌）。拿不到就算了，
  別為此改上游。
- POST `/instant-chat` 任何一步 await 失敗 → 客戶端收到明確錯誤 → 界面報
  發送失敗可重試。**絕不靜默轉回本地生成**。

## 已拍板的行為語義

- 連發兩條：第二條 POST 用 `supersedesUuid` 頂掉未認領的上一條（合併成一起回）。
  上一條已認領（正在生成）→ 讓它跑完，新任務靠 `serialize_group`（= charId）
  排隊，接受小概率兩條相近回覆。
- push 成功後、行刪除前 isolate 死掉 → cron 重跑 → 重複回覆。窗口極小，
  與現有定時任務同類，接受。
- 群聊不動（收件箱按 charId 路由，群聊沒有 charId）。
- presence / dirty-sync 機制**保留不退役**（開關關閉的用戶仍走本地路徑需要它們，
  打髒後微任務內立即上傳，同一輪的連環打髒合併成一次）；instant 分支天然繞開：
  不起 presence 心跳，POST 即上傳所以不 markDirty。

## 分工與邊界

**Agent 1（worker 側）只准動**：`worker/amsg/src/index.ts`、
`worker/amsg/src/` 下新文件（如 `instantChat.ts`）、`utils/amsgFirePack.ts`
（v7 類型與 parse）、對應 `*.test.ts`。

**Agent 2（前端側）只准動**：`hooks/useChatAI.ts`、`apps/Chat.tsx`（最小接線）、
`utils/activeMsgClient.ts`、`utils/activeMsgRuntime.ts`、`types.ts`
（`ActiveMsg2GlobalConfig` 加字段）、
`components/settings/ActiveMsgGlobalSettingsModal.tsx`、`worker/sw-keep-alive.ts`
（僅 when-hidden 調查結論落地）、對應測試。接縫在 `useChatAI.ts:1076`
現有 instant-push 分支旁，同樣排除 mcd/luckin/mcp 本地工具循環場景。

**共同紀律**：
- 禁跑任何改狀態的 git 命令；禁碰邊界外文件。
- `pnpm vitest run` 全綠；`pnpm build:workers` 通過（葉子模塊不得引入瀏覽器依賴，
  worker 側新 import 一律過一遍這條）。
- 新行為配迴歸守衛測試（舊行為下會掛、修好後過）。
- 測試 fixture 裡的用戶名用「小明」，不寫真實姓名。
- UTF-8；註釋密度與風格跟隨周邊代碼。
