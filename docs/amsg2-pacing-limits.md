# 主動消息 · 頻率與額度

用戶給每個角色定的主動消息上限。角色在這些上限之內自己挑時機：什麼時候接著說、要不要給自己排下一條。上限本身由代碼硬攔，排程時直接打回，到點時直接跳過，不靠提示詞去勸。提示詞只負責把「還剩多少額度」告訴角色。

面板入口：聊天設置 →「主動消息 2.0」→「主動頻率」卡片上的「調整」（`components/chat/ActiveMsg2PacingModal.tsx`）。

## 七項設置

都掛在 `ActiveMsg2CharacterConfig` 上，按角色分別設。沒設就用 `utils/amsgLimits.ts` 裡的默認值。

| 設置（字段） | 默認 | 設成 0 | 管哪些消息 | 在哪攔 |
|---|---|---|---|---|
| 沒回時最多連發幾條（`maxUnansweredSends`） | 3 | 不限 | 角色自排的 | 排程時 + 到點時 |
| 兩條之間至少隔多久（`minSendGapMinutes`） | 10 分鐘 | 不額外限制 | 角色自排的 | 排程時 + 到點時 |
| 每天最多主動找幾次（`dailySendCap`） | 不限 | 不限 | 全部定時消息（用戶手動排的也算） | 到點時 |
| 重複的消息連續幾次沒回就停（`recurringStopAfter`） | 3 | 不停 | 全部每天/每週重複的 | 到點時 |
| 最多同時排著幾條（`maxActiveTasks`） | 5 | 取值 1~10，沒有「不限」 | 用戶和角色共用 | 排程時 |
| 角色能不能排重複的（`allowSelfRecurring`） | 不能 | — | 角色自排的 | 排程時 + 到點時 |
| 角色能不能排「到點必發」（`allowSelfForce`） | 不能 | — | 角色自排的 | 排程時降級 + 到點時降級 |

幾條共同的口徑：

- 即時對話的回覆一律不算。那是正常聊天。
- 固定內容的任務不調模型，也不經過到點那幾道閘，所以「每天最多幾次」和「重複的連續沒回就停」都管不到它。面板文案裡寫明瞭「寫好固定內容的那種不算」。
- 「角色自排」看任務 metadata 上的 `amsgSelfScheduled`。前台工具橋和到點生成裡的排程工具都會打上這個標記。
- 「到點必發」沒放開時，角色的 force 不會被打回，而是按 expire 來排；已經排下的 force 任務到點時也按 expire 判。用戶自己排的 force 不受這項影響。前台改期（renew 一次性任務）沿用原任務的策略，不降級。
- 跳過是真的跳過：一次性任務當場被刪，不補發；重複任務只是推到下一次。
- 角色改期（renew）一條用戶自己排的一次性任務，改完還是用戶的任務：不打自排標記，策略沿用原來的。補當次（給重複任務補一條一次性的）算角色新排的。
- 「可以排重複的」沒開、角色名下卻還掛著重複消息時（比如這項設置出現之前排的），面板的「主動頻率」卡片上會提示這些不會再發，讓用戶自己選打開還是取消，不替用戶刪。

## 數據怎麼流

- **上限**：保存在本地 config 上。雲端單獨存一份 `limits` 記錄（命名空間 `amsg:char:<id>`，key `limits`，形狀見 `AmsgLimitsRecord`）。有兩條上傳路：
  - 面板保存時立刻單獨傳（`ActiveMsgClient.putCharLimits`）；
  - 每次傳 fire_pack 時順手帶一份（`buildCharStateEntries`）。
  worker 每次到點都讀這份記錄。記錄缺失或讀不出來時按默認值處理，默認值本身是偏嚴的那一側。
- **關 2.0**：面板會先把 `limits.selfScheduleEnabled` 寫成 false，再去取消任務。取消掃完之後才冒出來的自排任務（正在跑的那一輪順手排的），到點時會被 `schedule-off` 跳過。即時對話也關著的話，關閉時會把這個角色的雲端上下文整個清掉（limits 跟著一起沒了），這時殘留任務到點是讀不到上下文、直接失敗，同樣不會調模型。
- **升級窗口**：worker 換了新版、前端還沒刷新時，雲端沒有 limits 那份。這時連發上限退回讀老 fire_pack 上的 `maxUnansweredSends`，其餘幾項按默認值。前端第一次上傳上下文就會帶上 limits。
- **每日計數**：`daily_sends` 記錄，在同一個命名空間裡。worker 在 fire 收尾時累加，只記定時觸發，按**用戶那邊的日期**（fire_pack 的 `userTzId`）。裡面兩個數：
  - `sends`：發出去幾次，多段氣泡只算一次；
  - `llmCalls`：調了幾次模型，失敗和判空的也算。這個數要上游 amsg-server 在收尾 hook 上報 `llmCalls` 才有，老版本上游沒有這一項。
  面板上「今天 TA 已主動找你 N 次」讀的就是這份。推送失敗、但整批已經落進服務端收件箱的（收尾 hook 上 `outboxed` 為真），按「發出去了」記：上游重試時只補推原文，不會重新生成，而且補推那一跳不再調任何 hook。
- **重複任務連續沒回**：self_log 上的 `recurringSends`，按任務的 `clientTaskId` 各記各的，用戶一開口就和連發計數一起清零。

## 到點閘的順序（onBeforeFire）

只列跟這份文檔有關的幾道，按出現的先後排。每道攔下都會寫 `last_skip`，面板用 `describeLastSkip` 照實說明原因：

1. 用戶正在聊天（policy 為 expire 時才生效，沒放開的角色 force 在這裡已按 expire 算）→ `active-chat-presence`
2. 排程之後對話已經往前走了 → `conversation-moved-on`
3. 2.0 關了，或者角色自排了重複任務但用戶沒放開 → `schedule-off`
4. 角色自排的，連發已到上限 → `unanswered-limit`
5. 角色自排的，離上一條主動消息還沒隔夠。「上一條」按它開始生成的時刻算（日誌條目的 `startedAt`），跟排程時比的是同一個時刻；另有 3 分鐘寬限（`FIRE_GAP_TOLERANCE_MS`）兜住沒有 `startedAt` 的老條目 → `min-gap`
6. 重複任務連續沒回夠次數 → `recurring-unanswered`
7. 今天已發滿 → `daily-limit`

## 告訴角色的那一段

`buildLimitsBrief` 負責拼「用戶給你定的規矩」這一段，只列真在起作用的幾條，寫成事實。它出現在兩個地方：

- 到點生成時，接在「你可以給自己排下一條」說明塊的末尾，帶上還能排幾條、最早排到幾點、今天還剩幾條；
- 前台聊天時，放進排程現狀塊（`buildAmsg2TaskContextText`）。

排程工具的簽名也跟著設置走：沒放開的能力，對應的參數（`recurrence` / `expire_policy`）直接不出現。

## 改這塊時要一起動的地方

| 改什麼 | 位置 |
|---|---|
| 默認值、判定、給角色看的那段話 | `utils/amsgLimits.ts` |
| 到點那幾道閘、收尾計數 | `worker/amsg/src/index.ts` 的 `onBeforeFire`、`amsgFireSettled` |
| 到點排程工具的打回 | 同文件的 `runFireScheduleTool` |
| 前台工具簽名與打回 | `utils/amsg2ToolBridge.ts` |
| 面板 | `components/chat/ActiveMsg2PacingModal.tsx`、`ActiveMsg2SettingsModal.tsx` |
| 跳過原因的人話 | `utils/amsgFirePack.ts` 的 `describeLastSkip` |

worker 和前端都改了的話，**先部署 worker**，並把 `utils/amsgBundleVersion.ts` 往前推一版，讓設置頁提示用戶更新自己那台 Worker。
