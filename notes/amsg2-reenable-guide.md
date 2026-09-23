# 主動消息 2.0（amsg2）單用戶模式速查

> 什麼時候讀這份：改「主動消息 2.0」（角色到點自動發消息、App 關著也能收）相關代碼時，照這份快速上手。
> 更新時間：2026-07-26（多任務 + 防穿幫閘波之後）。下面是 `dev` 上的代碼現狀。

## 一句話現狀

amsg2 = 定時主動消息。運行模型是**單用戶 + 自帶 worker + 自帶 DB**：每個用戶自己部署一個 Cloudflare Worker（自帶 D1 數據庫 + Cron Trigger），SullyOS 前端只填「Worker 地址 + 共享密鑰」就能用，跟 Instant Push 一個套路。沒有多租戶、沒有 tenant token、沒有 Netlify Functions 後端。

**多任務**（2026-07 下旬起）：一個角色可同時掛最多 5 個任務（`ActiveMsg2CharacterConfig.tasks`
清單，短 id = taskUuid 前 8 位）；角色可在對話裡用 schedule/cancel/renew/list 四個
function-calling 工具自管排程（`utils/amsg2ToolBridge.ts`），設置面板（`ActiveMsg2SettingsModal`）
全量顯示並支持逐個取消/編輯。fire_pack v2 起「本次任務」指令是槽位，隨任務 metadata 走、
到點由 worker 填槽，多任務共用每角色一份模板不串味。

**防穿幫閘**（expire_policy，純判定在 `utils/amsg2ExpireGuard.ts`）：`expire`（默認）任務
到點時若對話已前進（一次性=創建錨點後有真實用戶消息；循環=到點前 10 分鐘內在聊）或
同角色活躍會話租約（`chat_presence`，15s 心跳 / 45s TTL，`utils/amsgChatPresence.ts`）
仍新鮮，worker onBeforeFire 直接 `{ skip: true }` 作廢本次觸發，一個生成 token 不花；
剩餘競態由客戶端送達兜底閘吞沒（`activeMsgRuntime` 的 runtime-expire-swallow，按
`amsgClientTaskId:occurrenceMs` 緩存同吞同放）。作廢不是消失：`utils/amsg2TaskContext.ts`
在下一輪組請求時把「進行中任務 + 未告知的作廢回執」拼成排程現狀塊注入 system，由角色
自行決定就地消化 / renew 續期 / 放棄；發送成功後 `markExpiredNoticesNotified` 落帳。
`force` 是鬧鐘語義，全綠燈照發；fixed 任務恆 force（走不了 worker 閘）。

AI 模式任務（自動/提示詞）走「滿血」鏈路：前端平時把帶時間槽位的完整 prompt
模板（fire_pack）同步到 worker 的 client_state 表，到點由 worker 現場填槽生成——
上下文是用戶最後一次聊天時的狀態，而不是排程那一刻的。worker 讀不到 fire_pack 時
直接拋錯、不拿排程時凍結的 prompt 頂包（見下面「狀態不完整時不降級」）。設計詳見
[`amsg-fullbg-state-design.md`](./amsg-fullbg-state-design.md)。

滿血鏈路帶**服務端工具循環**（v2）：LLM 輸出裡的數據標籤（RECALL / SEARCH /
READ_DIARY / FS_READ_DIARY / READ_NOTE / XHS_*）由 worker 就地執行後回填繼續生成
（默認 5 輪 / 240s，客戶端全程不用在線）；副作用標籤（POKE / TRANSFER / 寫日記 /
MUSIC_ACTION / XHS 互動等）結構化成 directives 掛最後一條 push 的 metadata，客戶端
收到時重放。classifier 與 instant push 共用同一份（`worker/amsg/src/classifier.ts`）；
最終正文的分段也與 instant / 客戶端氣泡共用同一份（`utils/sanitize.ts` 的
`sanitizeIntoSegments`：按換行切，`[[...]]` / `[html]` 等標籤塊保持原子不被句讀劈碎），
push 的 `notification.body` 帶淨化文本給系統橫幅，`message` 保留原始標籤給客戶端渲染。
工具憑據與 recall 數據由前端隨 fire_pack 同批上雲（tool_pack / tool_config），
沒同步或憑據缺失時工具以正常失敗回給 LLM 圓場，不斷鏈。
超 200KB 的大值（胖角色的 fire_pack）由 worker 存儲層透明分塊
（amsg-server 2.6.0-next.4+），前端整條直傳、讀回自動拼好；單個壞條目只拒自己
不連坐同批。worker 版本落後時前端用 `GET /capabilities` 探測，設置頁亮
「重新粘貼部署」提示，不靜默降級。

## 前端接入點

| 部件 | 文件 | 說明 |
|------|------|------|
| 發請求層 | `utils/activeMsgClient.ts` | 包 `@rei-standard/amsg-client` 的 `ReiClient`，構造用 `baseUrl=workerUrl` + `serverToken`。對外方法：`getGlobalConfig` / `getPushStatus` / `ensurePushSubscription` / `connect` / `listTasks` / `listAllTasks`（分頁全量，行帶上游投影的 charId/clientTaskId）/ `cancelTask` / `scheduleCharacterTask`（多任務 + replaceTaskUuid 先建後刪替換）/ `syncChatPresence` / `getCapabilities` / `clearClientState` |
| 多任務清單派生 | `utils/amsg2Tasks.ts` | 短 id、isPendingTask、pruneStaleTasks（過點 48h 出清單）、hasActiveAiTask（同步門）。清單隻存 `scheduled`，已發/作廢由消息歷史現場推導 |
| 防穿幫閘純判定 | `utils/amsg2ExpireGuard.ts` | shouldExpireFire / detectExpiredOccurrences / hasDeliveredProactiveNear（按 clientTaskId 精確歸屬）。⚠ 葉子模塊，worker 與瀏覽器共用 |
| 活躍會話租約 | `utils/amsgChatPresence.ts`（形狀/新鮮度判定）+ `utils/amsgStateSync.ts`（15s 心跳 timer）+ useChatAI（本地 fetch 路徑開/停租約） | ⚠ 葉子模塊。只代表「正在和這個角色交互」，切後台停續租，45s TTL 自然失效 |
| 排程現狀塊 | `utils/amsg2TaskContext.ts` | useChatAI 每輪組請求時檢出作廢回執（台帳在 `ActiveMsgStore`，封頂 10 條 / 48h TTL）+ 拼進行中任務清單注入 system；發送成功後標已告知 |
| 對話內工具 | `utils/amsg2ToolBridge.ts` | schedule/cancel/renew/list 四個 OpenAI tools + 執行器（useChatAI 工具循環分發）。renew 複用 schedule 的替換語義；遠端取消失敗絕不靜默移除本地記錄 |
| 全局配置 Modal | `components/settings/ActiveMsgGlobalSettingsModal.tsx` | 「部署 Worker」引導（複製代碼 + CF Dashboard 鏈接 + env 清單 + Master Key 生成）+ 填 Worker 地址 + 共享密鑰 + 「連接」+ 「開啟推送」。掛在 `apps/Settings.tsx`（Instant Push 那節旁邊）。「重新粘貼部署」探測 = features 齊全 **且** serverVersion ≥ 2.6.0-next.7（`utils/amsgWorkerVersion.ts`；next.4 起 features 清單幾乎沒動過，投影 / skip / 佔位租約 / writeState 都只能靠版本號識別） |
| 角色級調度 Modal | `components/chat/ActiveMsg2SettingsModal.tsx` | 任務列表（全量顯示、逐個取消/編輯、遠端對帳徽標）+ 新建/編輯表單：「固定/自動/提示詞」× 「一次/每天/每週」× 防穿幫策略（作廢/強制）。入口在聊天加號面板「主動消息 2.0」按鈕（鬧鐘圖標） |
| fire_pack 模板 | `utils/amsgFirePack.ts` | 滿血鏈路的 prompt 模板 + 時間槽位渲染，前端兜底與 worker 填槽共用同一份（時間文案單份維護，有迴歸測試釘住） |
| tool_pack / tool_config | `utils/amsgToolPack.ts` | 服務端工具循環的數據形狀：每角色的月度總結 / XHS 開關（tool_pack）+ 全局工具憑據 / 代理地址（tool_config），構建與 parse 前端 worker 共用 |
| 狀態同步層 | `utils/amsgStateSync.ts` | 每輪聊完（useChatAI 輪末）打髒標記，去抖 15s / 切後台立即，把 fire_pack + tool_pack + tool_config 批量 `putClientState` 上雲 |
| 工具實現（共用葉子） | `utils/agenticTools.ts` + `utils/realtimeFetchCore.ts` + `utils/xhsMcpClient.ts` | 九個數據工具的執行體。agenticTools 是 dispatch 入口（前端二輪 LLM / instant 續跑 / amsg worker 三處共用）；搜索 / Notion / 飛書的純 fetch 核心在 realtimeFetchCore（realtimeContext 的 Manager 委託它）。**這幾份是環境無關葉子，別往裡加瀏覽器依賴**——`pnpm build:workers` 會打進 amsg worker bundle |
| Worker 入口（本倉打包） | `worker/amsg/src/index.ts` + `worker/amsg/src/agentic.ts` | index 配 hooks（onBeforeFire 填槽 + 裝工具上下文、executeToolCalls 就地執行）；agentic 是決策純邏輯（classifier 分類、旁白 / 副作用跨輪累積、finish payload 組裝，有單測）。`pnpm build:workers` 產 `worker/amsg/worker.bundle.js` + `public/amsg-worker.bundle.js`（Modal「複製 Worker 代碼」讀後者） |
| 本地存儲 | `utils/activeMsgStore.ts` | `ActiveMsg2GlobalConfig` 存 IndexedDB；收發消息的 inbox/outbound/reasoning 存儲與 Instant Push 共用 |
| 類型 | `types.ts` | `ActiveMsg2GlobalConfig` = `{ userId, workerUrl, serverToken?, initializedAt?, updatedAt? }` |
| npm 依賴 | `@rei-standard/amsg-client`（2.9.0-next.4，含 serverToken + getVapidPublicKey + getCapabilities）、`amsg-shared` / `amsg-instant` / `amsg-sw`（latest）、`@rei-standard/amsg-server`（2.6.0-next.7，devDep，含 ctx.scratch + 存儲層大值分塊 + /capabilities + GET /messages 投影 charId/clientTaskId + onBeforeFire `{ skip: true }` 出口 + 任務佔位租約 `lease_until` + hook 的 `ctx.writeState` 與 Web Push 大小護欄 `measurePushPayload`） | amsg-server 只用於打 worker bundle，不進前端運行時。佔位租約那列由 `POST /init-tenant` 自動補，升級後在設置頁點一次「連接」即可 |
| 全流程體檢 | `scripts/amsg2-e2e-harness.mjs` | 本地跑提交的 worker.bundle.js 全流程（node:sqlite 模擬 D1 + 真實 web push 加解密 + mock LLM），覆蓋排程→cron→工具循環→push→skip 七組場景。改 worker/amsg 或升 amsg-server 後 `node scripts/amsg2-e2e-harness.mjs` 跑一次 |

## 送達層與 Instant Push 共用（收消息側白送）

worker 推的 web push → Service Worker（`worker/sw-keep-alive.ts`）收 → 寫 IndexedDB → `utils/activeMsgRuntime.ts` 落庫上屏。這條鏈和 Instant Push 共用，處理的就是 `ActiveMsg2InboxMessage`（metadata 標 `activeMsg2`）。amsg2 後端按標準 web push 格式推出來，前端收消息側一行不用改。

## 鑑權與請求頭

- 配了 `serverToken` → 每次請求帶 `X-Client-Token`；worker 端配了 `AMSG_SERVER_TOKEN` 就**全部端點強制校驗**（缺/錯回 401，all-or-nothing）。
- 業務端點還帶 `X-User-Id` + 加密頭（`X-Payload-Encrypted` / `X-Encryption-Version` / `X-Response-Encrypted`）。加密走 client 的 `_encrypt/_decrypt`，key 由 `client.init()`（GET /get-user-key）派生。

## Worker 側（用戶自己部署）

- **主線部署方式 = Dashboard 粘貼**（學 Instant Push，用戶不碰終端）：設置 Modal「部署 Worker」點「複製 Worker 代碼」拿到 `public/amsg-worker.bundle.js` 全文，去 CF 後台建空 Worker → Edit code 粘貼覆蓋 → Deploy。amsg-server 2.6.0-next.2 起全 Web Crypto，bundle 零 node 內置依賴，**不需要 `nodejs_compat` flag**。
- 備選 CLI 方式（wrangler）：`~/Documents/GitHub/amsg-worker/`（不在本倉，含 DEPLOY.md）。上游源碼/示例：ReiStandard `packages/rei-standard-amsg/server/examples/cloudflare-single-user/`。
- 端點：`POST /init-tenant`（冪等建表，前端「連接」按鈕會打它，用戶不用手動執行 schema.sql）、`GET /get-user-key`、`POST /schedule-message`、`GET /messages`、`PUT /update-message?id=`、`DELETE /cancel-message?id=`、`GET /vapid-public-key`、`GET /capabilities`（特性探測：`{ serverVersion, features }`，老部署無此路由 404，前端歸一成 null 後亮「重新部署」提示）。定時投遞由 Cron Trigger 直接跑 `scheduled()`，無 send-notifications 端點。
- 部署要配：D1 binding 名 `DB`（空庫即可，建表交給「連接」）、cron `* * * * *`、env `AMSG_MASTER_KEY`(32B hex，Modal 裡可一鍵生成) + `VAPID_EMAIL/PUBLIC_KEY/PRIVATE_KEY`（必須和「推送憑據 (VAPID)」面板同一對，見下節）+ 可選 `AMSG_SERVER_TOKEN`。
- **跨源必須配 CORS**：本倉入口默認 `cors: { origin: '*' }`，想收緊自行改成站點域名。沒配 CORS 時瀏覽器 preflight 被 worker 404。
- 定時推送 TTL 默認 4 周。

## 雲端狀態裡有什麼（爆炸半徑）

滿血 v2 的服務端工具循環要在到點時自己調 Notion / 飛書 / 搜索 / 小紅書，所以這些憑據得放在 worker 能拿到的地方。前端在排程和去抖同步時把三份數據寫進 worker 的 `client_state`：

| key | namespace | 內容 |
|---|---|---|
| `fire_pack` | `amsg:char:<charId>` | 完整 prompt 模板（角色卡、世界書、最近上下文），時間處留槽位 |
| `tool_pack` | `amsg:char:<charId>` | 該角色的月度總結、小紅書開關、角色名 |
| `tool_config` | `amsg:global` | Notion / 飛書 / news 的 key，小紅書 cookie，代理 worker 地址 |

傳輸走 client 的 `_encrypt`（key 由 `AMSG_MASTER_KEY` 派生），但 worker 到點必須解密才能用。所以實際的安全邊界是 **worker 自身**：拿到 worker 的 env（`AMSG_MASTER_KEY`）就能解出上面全部內容，包括那幾個第三方憑據。

這是把工具循環搬到服務端的固有成本，不是實現漏洞。想縮小暴露面的話：不需要的工具在「實時感知」裡關掉，`buildToolConfig` 只上傳已啟用項的憑據（`utils/amsgToolPack.ts`）。另外 `AMSG_SERVER_TOKEN` 建議配上——不配的話端點無鑑權，雖然讀消息內容仍需要加密 key，但 `DELETE /cancel-message`、`POST /init-tenant` 這類不帶 payload 的操作，知道 worker 地址就能打。

## 狀態不完整時不降級

排程鏈的順序是**先傳雲端狀態、成功了再建任務**（`putClientStateOrThrow`：網絡抖動重試兩次，最終失敗拋錯讓整個排程失敗）。這樣上傳失敗時遠端還沒有任務，不需要回滾，也不會出現「用戶看到排程失敗、遠端卻會到點觸發」。

對應地，worker 到點讀不到 `fire_pack`（或解析失敗、或任務缺 `amsgTaskInstruction`）時直接拋 `AMSG2_FIRE_STATE_MISSING`，不會退回任何凍結的 prompt——任務體裡也沒有第二份 prompt 可退（`messages` 只有一條佔位，正常路徑下會被 `onBeforeFire` 的返回值覆蓋）。拋錯走庫的投遞失敗路徑，重試 3 次後任務標 `failed`，日誌裡有 `[amsg:fire-state-missing]`。

迴歸守衛在 `worker/amsg/src/index.test.ts`（四道門與順序）和 `utils/activeMsgClient.test.ts`（上傳失敗必須拋錯）。

## VAPID 公鑰

前端訂閱時 `applicationServerKey` 必須是**這個 worker 自己**籤推送用的公鑰，否則推不動會 403。所以 `ensurePushSubscription` 運行時從 worker 拉公鑰，不再用 build-time env。

- 用 `client.getVapidPublicKey()`（amsg-client 2.9.0-next.1 新增）→ `GET {workerUrl}/vapid-public-key`，帶 X-Client-Token，返回 `publicKey` 字符串。worker 未配 VAPID 時返回 503 `VAPID_NOT_CONFIGURED`。
- worker 側端點在 amsg-server 2.6.0-next.1+；部署時 worker env 要有 `VAPID_PUBLIC_KEY`，且和籤推送用的是同一對密鑰。
- **worker env 的 VAPID 必須填「推送憑據 (VAPID)」面板裡那對**（`utils/pushVapid.ts` 共享存儲，與 Instant Push / Proactive Push 同一對）：一個 origin 只有一個瀏覽器 push 訂閱，`ensurePushSubscription` 有現成訂閱就直接複用，amsg worker 用別的密鑰對籤推送會 403。

## 聯調防坑

- `@rei-standard/amsg-*` 源倉改完 `link:../ReiStandard` 聯調時，**提交前 grep `pnpm-lock.yaml` 別讓 `ReiStandard` 寫進去**，否則 Netlify frozen install 失敗。
- `amsg-shared` / `amsg-instant` / `amsg-sw` 的 npm `next` tag 是老的低版本，別誤 `@next` 升（會降級）。要 next 的只有 `amsg-client`。
