# TODO 待辦

`/simplify` 掃 amsg2 分支時發現、但當時沒做的事。按「值不值得現在做」排。

---

## 見面（DateApp）· 歷史加載

三條都是同一個東西引起的：見面消息按 `metadata.source === 'date'` 過濾，但沒有對應的索引。

### 1. `getRecentMessagesByCharIdAndSource` 每次掃全量歷史

`utils/db.ts:624`。游標走的是 `charId` 索引，不是 `[charId, source]` 複合索引，所以它得把這個角色的**每一條**消息都反序列化出來（含 base64 圖片消息），一條條看 `metadata.source` 對不對，直到湊夠 limit 條。見面記錄稀疏的角色，等於每次都把整部聊天史讀一遍。

做法：加複合索引 `['charId', 'metadata.source']`（`db.ts:234` 的 `charId_type` 就是現成的先例），游標只訪問見面那些行。

### 2.「加載更多」每點一次都從頭重讀

`apps/DateApp.tsx:129-132`。`handleLoadMoreDateHistory` 是 `limit += 220` 再查一遍，所以第 k 次點擊會把前面 k-1 次已經讀過的全部重讀一遍，累計約 O(k²·220) 次行反序列化。

做法：改成游標續讀（`IDBKeyRange.upperBound(已加載的最舊 id)`），每次只取下一批。

### 3. 加載 effect 掛在整個 `char` 對象上，翻頁深度會被悄悄重置

`apps/DateApp.tsx:117-125`。`char = characters.find(...)`，characters 數組一更新（回覆後 `updateCharacter`、記憶宮殿回寫、情感評估……）`char` 就是個新引用，effect 重跑 → `setDateLoadLimit(220)` + 全量重掃。用戶翻到 660 條的位置會被拽回 220，還白付一次重讀。

做法：依賴改成 `char?.id`（和 `mode`），別用整個對象。

---

## amsg2 · 跨進程契約還沒類型化

任務 metadata 的 6 個鍵（`amsgExpirePolicy` / `amsgRecurrence` / `amsgAnchorMs` / `amsgClientTaskId` / `amsgOccurrenceMs` / `amsgTaskInstruction`）在三個地方各寫一遍：

- 生產：`utils/activeMsgClient.ts` 的 `payload.metadata` 字面量（類型是 `Record<string, any>`）
- 消費：`worker/amsg/src/index.ts` 的 `onBeforeFire`
- 消費：`utils/activeMsgRuntime.ts` 的送達兜底閘

生產方少寫一個鍵、拼錯一個字母，編譯器不會吭聲，要到點了才在 worker 裡拿到 `undefined`。

做法：起一個葉子 `utils/amsgTaskMetadata.ts`（跟 `amsgFirePack` / `amsgChatPresence` 同一族），導出 `AmsgTaskMetadata` 接口 + `buildAmsgTaskMetadata()` + `parseAmsgTaskMetadata()`。加字段就變成生產方的編譯錯誤。

---

## amsg2 · 效率（都還沒量過，按懷疑度排）

### 4. 每輪聊完的 fire_pack 刷新，把這一輪剛做過的活重做一遍

`utils/activeMsgClient.ts` 的 `syncCharFirePacks` → `buildFirePack`，每個角色都要：讀 200 條歷史、`DB.getEmojis()`（把整個表情庫全撈出來）、`DB.getEmojiCategories()`、再跑一遍 `ChatPrompts.buildSystemPrompt`（內部還會發實時感知的網絡請求）。而這份系統提示詞，聊天那一輪 15 秒前剛用內存裡的數據拼過一次。

而且這事會在切後台（`visibilitychange → hidden`）時立刻觸發 —— 正是 iOS 只給幾秒存活窗口的那個時刻。多角色還是 `for await` 串行的。

三檔做法，由淺到深：
- 把 `getEmojis` / `getEmojiCategories` 提到循環外（它倆是全局的，不按角色變）
- 各角色的 `buildFirePack` 併成 `Promise.all`（互相獨立，只有最後那次 PUT 需要合成一次）
- 讓聊天那輪把已經拼好的系統提示詞經 `AmsgSyncSnapshot` 帶過來，沖刷時只重新填模板

### 5. 每次 amsg2 調用都重建 `ReiClient`（多一次 `/get-user-key` 往返）

`initializeClient` 不緩存。聊天期間的 presence 心跳每 15 秒一次，每次都要 2 次 IDB 讀 + 2 次網絡往返，就為寫 ~80 字節。一次 60 秒的生成 = 5 輪。

做法：按 `userId + workerUrl` 記住已初始化的 client，`saveGlobalConfig` 時失效。

### 6. `collectAmsg2TaskContext` 在發送關鍵路徑上重讀 200 條歷史

`hooks/useChatAI.ts:990`。同一輪裡 `useChatAI` 已經讀過 `contextLimit` 條了，這裡又獨立讀 200 條（同一個 store、同一個角色、嚴格子集），而且是在 LLM 請求**之前** await 的，等於給每條消息都加了一段延遲。

做法：把已有的 `contextMsgs` 傳進去（它只讀 `role` / `timestamp` / `metadata`）。

### 7. `isAmsg2GlobalReady()` 擋在每一次發送前

`hooks/useChatAI.ts:918`。沒配過 amsg2 的角色 `isAmsg2EnabledForChar` 默認返回 true，所以 `&&` 右邊一定會跑：開 ActiveMsg 庫 + 一次 KV 讀，inline await。所有用戶、每條消息、永遠。

做法：`ActiveMsgStore` 裡模塊級緩存全局配置（只有設置面板會改它），或者每次 hook mount 解析一次存 ref。

### 8. `tool_pack` 每次沖刷都全量重傳

`char.memories` 的全部月度總結每次都重新序列化上傳，但它大概一個月才變一次。

做法：按角色記住序列化後的 hash，沒變就不放進這一批（批量 PUT 本來就是按條目的）。

---

## amsg2 · 已評估但**故意不做**的

- **`ActiveMsgGlobalSettingsModal` 的 `capabilities` 探測**：保留。worker 是用戶手動粘貼部署的，前端會自動更新而 worker 不會——這是全鏈路裡唯一一處新舊真會不一致的地方。而且它是給用戶看的「該重新部署了」提示，不是靜默降級。
- **`agenticTools` 的 `not_configured` 分支**：保留，但保留的理由變小了。提示詞本來就按配置裁剪（沒配的工具連說明都不注入），正常不會撞上；原先「設置裡關掉某個工具」到「下次跟該角色聊天」之間有個窗口，雲端提示詞還在介紹那個已關掉的工具——這個窗口現在已經由 `refreshAmsgPromptsAfterToolConfigChange` 堵上了（改憑據時 tool_config 和 fire_pack 一起刷）。剩下真正需要它的只有「LLM 幻覺出一個沒被介紹過的標籤」。
