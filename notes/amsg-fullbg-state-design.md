# 滿血後台消息：雲端狀態表 + 服務端工具鏈設計

> 什麼時候讀：做「滿血後台消息」（角色到點自動發消息，上下文新鮮、可帶工具、全程雲端閉環）相關工作前。
> 這份講 SullyOS 側的整體設計與分工；上游 amsg-server 要改什麼見
> [`amsg-server-fullbg-hooks-prompt.md`](./amsg-server-fullbg-hooks-prompt.md)。
> 更新時間：2026-07-17。

## 一句話目標

主動消息從「排程時凍結一段 prompt，到點一次 LLM」升級成「到點由 worker 現場組裝新鮮上下文、
（可選）跑完整工具循環、推送成品」——**中途永遠不需要客戶端在線**，不會跑一半彈個通知叫用戶
回前台取數據。

背景：Instant Push 受平台限制（iOS 殺後台、SSE 壽命等）實際效果有限，轉入有限支持；
後台體驗的主力改走本方案（amsg2 單用戶 worker + D1 那套底座，見
[`amsg2-reenable-guide.md`](./amsg2-reenable-guide.md)）。

## 核心判定原則

**worker 在 fire 時刻要讀的數據才需要上雲；客戶端收到 push 之後才用的，一概留在本地。**

後處理鏈路（表情包名字→URL 反查、卡片渲染、directive 重放、擬人分泡）全部發生在客戶端收到
push 之後（`activeMsgRuntime` / `applyAssistantPostProcessing`），雲端只負責產出「帶業務標籤的
文本 + directive metadata」。表情包表、歌單、卡片邏輯都不上雲。

## 工具怎麼保證「整條鏈在雲上跑得完」

LLM 每輪要調什麼工具是運行時才知道的，所以完備性不能靠猜，靠兩件事：

1. **數據源提前就位**（下面的狀態表）；
2. **後台模式暴露給 LLM 的工具清單由 worker 注入**——清單裡只放雲端可滿足的工具，
   完備性是構造出來的。沒開遠端向量庫的用戶，清單裡就沒有 recall，而不是跑一半斷掉。

按依賴類型把工具切三類，真正要上雲的東西立刻收斂：

| 類型 | 例子 | 雲端需要什麼 | 說明 |
|------|------|------------|------|
| 副作用類 | 表情、poke、轉帳、日程卡、音樂、XHS 點贊/評論 | **無** | worker 只識別標籤 → 塞進 push 的 directive metadata → 客戶端收到時重放。LLM 寫完標籤就繼續生成，不等執行結果，鏈不會斷。instant classifier 已是這個模式，直接複用 |
| 外部服務類 | XHS MCP、web_search、Notion/飛書 | 憑據 + 配置（幾行 KV） | 數據在外部服務上，worker 直調。XHS 走現成的 `utils/xhsMcpClient.ts`（零依賴葉子，MCP / Bridge 雙模式，worker 原樣打包）；搜索 / Notion / 飛書經用戶的代理 worker 轉發（`utils/realtimeFetchCore.ts`）。**硬限制：只有公網可達（或走用戶自部署代理）的服務可用**，本地起的 XHS 服務後台夠不著——夠不著時工具以失敗結果回給 LLM 圓場，鏈不斷 |
| 本地數據讀取類 | recall 記憶（`char.memories` 月度總結） | 數據進狀態表（`tool_pack`） | 真正的同步對象。月度總結是幾 KB 文本，直接隨 tool_pack 上雲，worker 本地過濾月份即可，不需要向量檢索 |

## client_state 通用狀態表

一份活狀態、單寫者、按 namespace 組織。不按任務存多份快照——主動消息語義上就該基於
「用戶離開時的狀態」，快照的"陳舊"是正確語義不是妥協。

```
client_state (user_id, namespace, key, value, updated_at)
PRIMARY KEY (user_id, namespace, key)
```

**v1 實際佈局（已落地）**：每角色一個 namespace、單條 `fire_pack`——前端把完整 prompt
拼好、時間性內容（當前時間/離開時長）留 `{{AMSG_*}}` 槽位，worker fire 時只做填槽，
連拼裝順序都不用知道（`chatPrompts` 不進 worker 的紅線執行到極限形態）：

| namespace | key | 內容 | 寫入時機 |
|-----------|-----|------|---------|
| `amsg:char:<id>` | `fire_pack` | `{ v, template(帶時間槽位的完整 prompt), lastUserMessageAt, tzOffsetMin, targetName }` | 每輪聊完（去抖 15s）/ 切後台立即 / 排程成功後 |

代碼位置：模板+渲染 `utils/amsgFirePack.ts`（前端兜底與 worker 共用同一份，時間文案單份維護）、
髒標記+批量上傳 `utils/amsgStateSync.ts`（掛 useChatAI 輪末 finally）、worker 填槽
`worker/amsg/src/index.ts` 的 onBeforeFire。

**v2 工具循環分段（已落地）**：

| namespace | key | 內容 | 寫入時機 |
|-----------|-----|------|---------|
| `amsg:char:<id>` | `tool_pack` | recall 用的月度總結（`char.memories`）+ `activeMemoryMonths` + XHS 角色開關 + 角色名 | 與 fire_pack 同批 |
| `amsg:global` | `tool_config` | 搜索 / Notion / 飛書憑據 + XHS MCP 配置 + 代理 worker 地址（realtimeConfig 的工具子集） | 與 fire_pack 同批（快照沒帶 realtimeConfig 時跳過，不覆蓋雲端已有憑據） |

數據形狀與 parse 都在 `utils/amsgToolPack.ts`（前端 / worker 共用葉子）。設計早期
設想過的獨立分段最終沒有出現：recall 實際讀 `char.memories` 月度總結（幾 KB 文本），
不需要 embedding / 向量庫憑據；情緒快照與用戶畫像已隨 fire_pack 模板整體帶上
（模板 = 完整 chat system prompt），不需要單獨條目。

要點：

- **寫側**：髒標記 + 去抖，在「一輪聊完」和 `visibilitychange→hidden` 時把變過的 namespace
  **批量一次** upsert。iOS 切後台的存活窗口只有幾秒，禁止逐鍵逐條實時寫。
- **讀側**：worker fire 時按需 SELECT，拼 prompt 和工具取數走同一張表。
- **單寫者**：客戶端寫狀態，worker 只寫自己的 outbound log（已有），天然無衝突。
  多設備場景 v1 用 `updated_at` 最後寫贏，不做精細合併。
- **拼 prompt 的分工**：客戶端繼續負責「拼」（分段上傳），worker 只做「組裝 + 補時間性內容」
  （當前時間、用戶離開多久、worker 自己發過什麼）。`chatPrompts.ts` 上千行且常改，
  **不要**移植到 worker 端雙份維護。
- **加密**：value 用 amsg-server 現有的 per-user storage 加密落庫（同 completePrompt 的待遇）。
- **體量**：單條 value 控制在百 KB 量級；全量向量這類大塊頭不進這張表（在 Supabase）。

## fire 時的完整鏈路

```
cron 到點
  → 讀 client_state（persona / recent_window / emotion / profile）
  → 組裝 prompt（+ 當前時間、離開時長、outbound 歷史）
  → LLM 輪 1 → classifier 分類輸出
      ├─ 純文本/副作用標籤 → finish：切 push + directive metadata
      └─ 數據標籤（recall / MCP_CALL / SEARCH…）→ worker 直調工具 → 結果回填 → LLM 輪 2 …
  → （輪數達上限強制 finish）
  → web push 推出 → SW 落 inbox → 客戶端打開時後處理照舊
```

多輪循環的時長大頭是等 LLM 的 IO（CF scheduled 裡不吃 CPU 配額），但輪數與總時長必須有
兜底：**默認 5 輪 + 240s**，工廠級可配、單次 fire 可覆蓋（`onBeforeFire` 返回值攜帶）——
有些工具（長搜索、外部慢 API）確實更耗時，應用層按任務自行判斷放寬。

## 分期

| 期 | 內容 | 備註 |
|----|------|------|
| v1 | 狀態表 + 同步層 + fire 時新鮮組裝（無工具） | 滿血的主要價值（新鮮上下文/情緒/多氣泡）在這一期就兌現 |
| v2 | 服務端工具循環：副作用 directive + 九個數據工具就地執行 | **已落地**。classifier 原樣複用 instant 那份（`worker/amsg/src/classifier.ts`）；決策純邏輯在 `worker/amsg/src/agentic.ts`（旁白 / 副作用跨輪累積，finish 一起出），工具執行走共享的 `utils/agenticTools.ts` dispatch（搜索 / Notion / 飛書的 fetch 核心抽在 `utils/realtimeFetchCore.ts` 葉子裡，前端 Manager 委託同一份）。副作用 directives 掛最後一條 push 的 metadata，收側與 instant 共用重放 |

## 依賴與坑

- **上游 amsg-server 要加東西**（client_state 端點、fire hook、服務端 agentic 循環），
  見交接 prompt。發版鏈：改庫 → next tag → SullyOS 升 devDep → 重打 bundle → 用戶重新粘貼部署。
  **worker 先行、前端後上**，前端用版本探測守門。
- 狀態表裡有真·隱私數據（聊天窗口、人設）。雖然是用戶自己的 worker + D1（和 API key 同
  信任級），但設置裡要有「清除雲端狀態」入口；導出/備份後續考慮。
- recall 只對開了 Supabase 遠端向量的用戶可用，純本地向量用戶的後台工具清單裡不出現 recall。
- 群聊暫不在範圍內（群聊當前也不走 instant/amsg 生成）。
