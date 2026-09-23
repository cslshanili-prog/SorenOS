# 主動消息 2.0 · 把更多 LLM 調用搬到雲端

聊天和情緒評估已經跑在用戶自己的 CF Worker 上了。這份記的是「還有哪些 LLM 調用點值得搬上去、按什麼順序搬、哪些不該搬」。

> **現狀（2026-08-15，dev）**：路已經修好，第一個調用點（門牌整理）跑通了。
>
> | | 落在哪 |
> |---|---|
> | `kind → handler` 註冊表 | `worker/amsg/src/fireKinds.ts`。分派點在聊天那四道門**之前**，所以後台任務不用傳 fire_pack / tool_pack |
> | 後台任務的通用約定 | `utils/amsgTaskKinds.ts`：`metadata.amsgKind` 標種類、`amsg:job` 命名空間放一次性輸入、`messageSubtype: 'job'` 讓它們不出現在用戶的任務清單裡 |
> | 結果回程 | `ctx.emitResult` → 服務端收件箱 → 客戶端上線補收 → `utils/amsgResults.ts` 按 `resultKind` 派活。門牌的結果帶 `notification: { show: false }`，只落帳本不發推送 |
> | `clientStateTtl` | 只配在 `amsg:job` 上（3 天）。角色狀態那個命名空間絕不能配，配了就是定時把 fire_pack 抹掉 |
> | 門牌整理 | 提示詞/解析/合併抽進零依賴葉子 `utils/memoryPalace/roomPlateCore.ts`，瀏覽器和 worker 共用；雲端那條路在 `roomPlateCloud.ts`，worker 側在 `worker/amsg/src/plateFire.ts` |
> | 憑據 | credRefs 加了 `memory` 一檔（記憶宮殿副 API）。沒配副 API 就不上雲，不回落到主 API |
>
> 三件上游基建其實 **2.6.0-next.21 就帶了**（next.22 是「不彈通知的 push 只落收件箱」那條行為變更，對 SullyOS 零影響——error push 是繞過庫直發的，reasoning / tool_request 在 amsg2 鏈路上本來就不發）。
>
> 門牌的三個觸發點只上了一個：**消化尾聲的全量整理**（`consolidateAllPlates`）。另外兩個留在本地——盒子壓縮那個一輪裡可能跑好幾次、後一次要看到前一次的結果，異步化會讓它們拿同一份快照互相覆蓋；手動回填有進度條，批次之間也是串行依賴的。要上雲得先做合批。
>
> 一個下面正文裡沒提到的坑，**提交到落地之間隔著一兩分鐘，這期間門牌可能被別的路徑動過**（封盒、手動回填都在本地跑）。提交時把每塊門牌的條目 id 一起帶上、結果原樣回傳，落地時靠這份對照表處理兩件事：
>
> | | 不處理會怎樣 |
> |---|---|
> | 標籤對準（`remapBasedOnLabels`） | LLM 說的 `basedOn: "U0"` 是**快照裡的第 0 條**，門牌一動它就指到另一條認知上，兩條的來歷（`firstLearnedAt` / `sourceCount`）被悄悄接錯 |
> | 護住新條目（`mergeCloudPlateEntries`） | 合併語義是「沒被重新輸出的條目淘汰」，而快照之後新增的條目 LLM 壓根沒見過。照原樣合併就是把它們靜默抹掉，用戶看到剛沉澱的認知憑空消失。它們也有專門的位子：整理結果佔滿上限時，先裁結果再塞新條目（一半封頂），不能整批扔掉——來源節點已經打過 `digestedAt`，扔了就是永久丟 |
> | 護住本地編輯（`keepLocalEditsOverStaleRewrites`） | 門牌面板是人工糾錯的口子。用戶在等結果這幾分鐘裡改對的那條，判據是「`updatedAt` 晚於**讀快照那一刻**」——在飛記號裡存的就是這個時刻，不是提交時刻（中間還隔著拼身份上下文、探測 worker、保底併入候選）。從建出來就沒被改過的條目不算，否則保底併入的粗糙候選會擋住整理對它們的改寫 |
>
> 同一個角色**同時只許一份整理在飛**（`roomPlateCloud` 的在飛記號，localStorage，30 分鐘超時放行）。兩份先後落地就是拿兩份舊快照互相蓋，還白燒一次 API。這時候不退回本地跑——本地那一遍同樣會跟在飛那份撞車，所以判定是三態：交得出去 / 退回本地 / 這輪跳過（只做送達保證）。`plateCloudGate` 裡三道門的順序有講究：「這台 worker 認不認識後台任務」排在「有沒有在飛的」前面（路斷了就該退回本地幹活），但探測**問不到**時反過來先看在飛——網絡抖一下不等於路斷，那時候退本地就是跟雲端那份撞車。
>
> 結果這條腿有自己的時效：補收不套聊天那兩天的窗口（結果晚到本來就是常態），但帳本留 28 天，重裝 PWA 的用戶一接上就會把老結果一次性拉回來，所以帳本上記的時間隨結果交給 handler，門牌那邊超過一週就直接銷帳丟掉。同一份結果會被送到兩次以上（銷帳那步失敗會重放，推送直達那條腿收下之後壓根不銷帳、補收時又來一遍），而落地不是冪等的——合併對每條保留下來的條目 `sourceCount + 1`，那就是門牌面板上的「印證 N 次」。所以本地留一本「哪些 job 已經落過地」的底帳，見過的直接銷帳。結果落地前還要確認**角色還在**：刪角色清的是雲端那份輸入，而結果回來說明 LLM 早跑完了、輸入那會兒已經被 worker 刪掉，不攔的話會給一個已經不存在的角色重新建出四塊門牌。
>
> 後台任務在調度器裡的兩處「別跟聊天混為一談」：
>
> | | 不分開會怎樣 |
> |---|---|
> | `onStaleSkip`（`amsgStaleSkip`） | 那份 `last_skip` 留痕說的是「這條**主動消息**到點為什麼沒響」，主動消息面板照它給用戶解釋。服務停擺幾小時之後一條掛著的門牌整理被過期跳過，用戶會看到「上次主動消息沒響、已被丟棄」，而那個角色根本沒排過主動消息 |
> | `serializeBy` | 分組鍵原先只取 `charId`。一次門牌整理最長佔住這個角色 120 秒，而它恰恰是在一輪對話剛結束時起跑的——用戶下一句話的即時對話任務排在它後面，人就乾等著「正在輸入…」。改成 `charId#kind`：同種後台任務之間仍按角色串行（兩份整理併發落地就是拿兩份舊快照互相蓋），但不擋聊天 |
>
> 門牌本身是「整塊對象存回去」的形狀，而動它的路有四條（雲端結果落地、本地整理落庫、送達保證兜底併入、門牌面板手改），彼此完全不知道對方存在。各自在自己那條路里排隊不夠——隊伍必須是**按門牌**的一條、所有路共用，所以收在 `utils/memoryPalace/db.ts` 的 `mutatePlate` 裡。`amsgResults` 那條全局分發隊列有 60 秒超時，而超時只是放行、不取消卡住的 handler，所以它不能是數據安全的唯一依靠；往那張表裡加新 handler 時照著辦：自己那份數據自己鎖。

上雲帶來的是**頁面關著也能跑完**：請求交出去那一刻客戶端就自由了，切後台、鎖屏、殺進程都不影響雲端把結果跑完送回來。所以值不值得搬，看的不是技術上能不能，而是這個調用點的用戶在不在場。

---

## 一把尺子

**收益 ≈ 生成時長 × 用戶離開的概率。**

- 生成 3 秒的東西上雲，收益接近零，成本照付。
- 生成 60 秒、且用戶大概率已經切走的，收益最大。
- 用戶必須當場看到下一句才能繼續的（通話），上雲是負收益。
- 雲端只有異步一種形態（沒有同步流式通道），所以先看結果能不能晚點到——必須當場拿到的，直接不考慮上雲。

成本那頭有三項，按大小排：

| 成本項 | 說明 |
|---|---|
| 依賴剝離 | 要在雲端跑的那段邏輯必須變成零瀏覽器依賴的葉子（不碰 IndexedDB / localStorage / window / React）。這一步通常佔整個工作量一半以上 |
| 失敗兜底 | 本地跑掛了當場報錯就完了；上雲掛了可能是「任務還在雲上跑著，客戶端不知道」。要寫「這條沒回來怎麼辦、怎麼讓用戶看懂、怎麼區分還會重試和徹底沒了」 |
| 雙路徑維護 | 本地路徑刪不掉（用戶沒配 Worker 就得能用），所以每接一個點就多一份分流判斷和留痕 |

---

## 先修路

在接任何新調用點之前要鋪的東西。鋪完之後下面那批基本是填表。

### SullyOS 這邊

**`kind → handler` 註冊表。** 上游只給 `onBeforeFire` 一個入口，所有 LLM 類任務都從這裡進。先立一張 `kind → handler` 的表按 `metadata.kind` 分派，別讓它長成大 switch。

這是業務分派，不該放上游 —— 上游只需要知道「有個 hook」，不需要知道「有種任務叫日程生成」。

### 上游（ReiStandard / `@rei-standard/amsg-server`）

三件通用基礎設施，建議攢成一次發版一起推。改動都不大，但每推一次所有用戶都要重新部署 Worker，分三回不划算。

| | 做什麼 | 為什麼放上游 |
|---|---|---|
| client_state 的 TTL | run-tick 順手清過期 key，按 `updatedAt` 判、按 namespace 配保留天數 | 庫現在明說不做 TTL 也不回收，每天一份日程一年就是 365 個 key 躺著。run-tick 裡已經在清 outbox（已 ack 留 7 天、全部留 28 天），加一個清 client_state 完全同構 |
| 請求體 gzip 自動解壓 | `parseBodyAsObject` 前面加 `Content-Encoding: gzip` 判斷，用 `DecompressionStream` | 宿主自己做不乾淨：能攔的只有自己前置的端點，而大 body 恰恰走上游的 `PUT /client-state`。上游做一次所有端點全通 |
| `ctx.emitResult(payload)` | 把「往 outbox 塞一條自定義結果」變成正式能力 | 現在 `appendPushesToOutbox` 沒導出，宿主要塞非聊天的結果只能拿 `db.appendOutboxMessages` + `encryptForStorage` 手工拼，無文檔無測試。收編之後客戶端直接吃現成的 `GET /outbox?since=` 補收，不用為每個 kind 寫一套輪詢 |

**TTL 那條別加列。** `client_state` 表已經有 `updatedAt`，按它判就行。加列會撞上「升級後老表不加列 → cron 每分鐘靜默掛、界面一切正常」那條最貴的坑。

**兩件建議別順手做：**

- 給 `message_type` 加新枚舉值。D1 上是 `CHECK` 約束，改約束等於改表，同樣撞上面那條坑。用 `metadata.kind` 區分業務類型完全夠。
- 給建 / 改 / 刪任務加生命週期 hook。這輪上雲一個都用不上。

---

## 接入順序

### 第一個：門牌整理

`utils/memoryPalace/roomPlates.ts:185`

拿來驗證骨架的。全項目成本最低的真實調用點：

- 請求體 10–15KB 且有硬容量上限
- 輸出是完整新列表，不是相對編號，不需要回本地做 ID 還原
- 合併邏輯 `mergePlateEntries` 已經是可測的純函數
- 失敗還自帶 `fallbackMergeSubmissions` 機械兜底
- 用戶永遠不在場

收益不大，但它是唯一一個能在不碰任何難點的前提下把整條路跑通的。

### 補斷層（收益最高）

提取 → 壓縮 → 門牌是一條鏈，全程用戶不在場。

| 調用點 | 生成時長 | 卡點 |
|---|---|---|
| 記憶提取 `utils/memoryPalace/extraction.ts:350` | 長（180s 超時） | 請求體滿載 ~450KB；輸出的 `relatedTo:"O2"` / `unpin:"P0"` 是相對本次打包順序的編號，還原必須對著本地節點表 |
| 認知消化 `utils/memoryPalace/digestion.ts:240` | 長 | 輸出 `A0/W0/E3` 索引動作，`executeActions` 全是本地狀態機（搬房間、建節點、打 `digestedAt`） |
| EventBox 壓縮 `utils/memoryPalace/eventBoxCompression.ts:123` | 中 × N 個盒 | 後半段（summary 重新 embedding、live 節點批量標 archived、box 狀態機）全在本地 |

**為什麼值得吃這個成本**：現在角色能在頁面關著的時候發消息，但這些消息產生的記憶要等頁面打開才整理 —— 雲端生成、本地消化，中間斷了一截。`extraction` 的觸發點裡已經有一個是「主動消息推送回來之後」，這條鏈本來就該在雲端連上。

這批是唯一補已有缺口的，其餘都是錦上添花。

**前置**：請求體先解決，不然一個都做不了。

### 慢生成 + 用戶大概率切走

| 調用點 | 時長 | 離開概率 | 成本 |
|---|---|---|---|
| 手帳 `utils/handbookOrchestrator.ts:573` | 極長（1+N 串行，最多 7 次） | 高 | 中 —— 進度條要改成靠推送回傳 |
| 見面 `apps/DateApp.tsx:214` | 長（8000 tokens，上下文重） | 中 | **低** —— 見下 |
| 日程 `utils/scheduleGenerator.ts:226` | 長（8000 tokens） | 高 | 中 —— 召回照 fire_pack 那套留在本地做 |
| 月度精煉 `apps/Character.tsx:443` | 長（整月日度總結不截斷） | 高 | 極低，但卡請求體 |
| 小說章節總結 `components/novel/NovelWriter.tsx:392` | 長（200k 字符截斷） | 高 | 低 |
| 強制重總結某天 `apps/Character.tsx:530` | 極長 | 高 | 低，但請求體 ~600KB，全倉庫最大 |

**見面可以提前做**，它是唯一能複用現有 instant-chat 那條路的：

- 落庫形態跟聊天完全一樣 —— `apps/DateApp.tsx:443` 就是 `DB.saveMessage({ charId, role, type:'text', content, metadata:{ source:'date' } })`，只差一個 `source` 字段
- 上下文構建也是同一套 —— `utils/datePrompts.ts:732` 用的是 `injectMemoryPalace` + `ContextBuilder.buildCoreContext`，跟聊天一模一樣

差異只有三處：回灌落庫要帶上 `source:'date'` 別落進聊天流；fire_pack 要能裝 datePrompts 版的 system prompt（還帶個 `skipTimeAwareness`，見面可以脫離現實時間線）；`savedDateState` 會話狀態怎麼跟雲端對齊。

至於逐句播放、TTS、觀測 HUD、立繪 —— 都是收到文本之後的瀏覽器後處理，跟請求從哪兒發出去無關。

**日程的觸發方式要先定**：現在是「進聊天界面發現沒有當日日程就後台生成」。上雲後建議改成建一條 `recurrenceType:'daily'` + `tzId` 的循環任務，凌晨按角色時區自己跑（上游的時區推進、夏令時收斂都是現成的）。還掛在「進界面時」的話，「頁面關著也能跑完」這個收益就沒了。

### 順手批

骨架建好後基本是填表。全部離開概率 100%、函數已經是純的：

| 調用點 | 備註 |
|---|---|
| 群話題盒 `apps/GroupChat.tsx:1114` | 已經是每輪生成後後台自動跑 |
| 世界結卷 `utils/worldHome/chapters.ts:128` | 全純，api / episodes / members 全從參數進 |
| 關係對話總結 `utils/relationshipChat.ts:250` | 全純，字符串進字符串出 |
| 教學記憶 `apps/StudyApp.tsx:876` | 順手把漏掉的 catch 補上（現在是裸 `.then()`，失敗是個靜默丟掉的 rejection） |
| 日記歸檔總結 `apps/JournalApp.tsx:594` | |
| 小劇場 `utils/theaterGenerator.ts:168` | 只吃 char / user / schedule 三個可序列化對象，不讀消息歷史 |
| 外部記憶搬家 `utils/memoryPalace/externalMemory.ts:297` | 函數內零 DB，10000 字/批天然分片友好 |

### API 連通性測試

`apps/Settings.tsx:2316`

這個要改成**測實際會走的那條路**。開了主動消息 2.0 之後真實請求從 CF Worker 發出，而這個按鈕測的是瀏覽器直連 —— 測過了不代表能用，測掛了也不代表不能用。用戶看到綠燈然後消息發不出來，是最難查的一類。

做法二選一：按當前路由測對應路徑；或者兩條都測、分別顯示結果。

### 能上但不急

| 調用點 | 為什麼排後面 |
|---|---|
| 節日事件（520 / 情人節 / 白色情人節） | 生成極慢（`max_tokens` 到 32000），但一年一次，且是全屏 loading 的線性劇本流程，異步化要重做整個 phase 狀態機 |
| 課程大綱 `apps/StudyApp.tsx:578`、出題 `:997` | 單次純 JSON，收益中等 |
| 交換日記 `apps/JournalApp.tsx:483` | 一天一篇，晚點看完全成立；輸出是 JSON + 貼紙結構，要新的回灌形態 |
| 相冊點評 `apps/Gallery.tsx:162` | 要傳圖片 base64 上雲，吃請求體預算 |
| 群聊導演 `apps/GroupChat.tsx:1248` | 用戶在等，且帶 MCP 工具循環 |
| 小屋 `utils/worldHome/engine.ts:274`、彼方 `utils/vrWorld/runSession.ts:141` | 已經是全局定時器後台跑，離開概率 100%；但它們是帶共享可變狀態的多輪編排（每個角色一拍要讀到前面角色剛寫進 `world.threads` 的東西），外加十幾張表讀寫和多處 `window.dispatchEvent` 驅動 UI。接之前先確認這個判斷 |

---

## 不接

| 調用點 | 理由 |
|---|---|
| 通話正文 `apps/CallApp.tsx:2032` | 唯一的硬否決。返回值直接驅動 `thinking → speaking` 並立刻喂 TTS 出聲，前面接著瀏覽器原生 ASR，是個閉環實時鏈路，中間插一個「等推送」就斷了 |
| 通話動作導演 `apps/CallApp.tsx:1929` | 串在正文和播音之間，純延遲成本，且已有本地降級 |
| 見面台詞翻譯 `components/date/DateSession.tsx:224` | 擋在出聲前的小請求，上雲只讓語音更慢 |
| 寫歌 AI tag `utils/aceStepApi.ts:192` | 輸出一行字符串，秒回 |
| 出歌 `utils/aceStepApi.ts:494` | 不是 LLM，是 Replicate 長輪詢，而且已經走 `workerBase()` 代理了 |
| 記憶檢索側（`pipeline.ts:321` / embedding / rerank） | 打的是本地 IndexedDB 向量庫 + BM25 + 鏈接圖，雲端無庫可查；而且它不需要上雲 —— 產出已經隨 fire_pack 烘進 system prompt 送上去了 |
| 舊記憶遷移 `utils/memoryPalace/migration.ts:321` | 每批落庫後下一批要向量召回搜到它才能建跨 chunk 關聯，是硬閉環 |
| 網頁編造 `apps/BrowserApp.tsx:301` | 結果不落庫、刷新即丟，用戶點了鏈接就是要立刻看到，異步化等於功能消失 |

死代碼，評估時直接跳過：`utils/handbookGenerator.ts:377` / `:521`、`utils/pixelHomeDecoration.ts:24`、`utils/avatarTouch.ts:427`、`utils/companionStartup.ts:251`、`utils/scheduleGenerator.ts:367`。

---

## 硬約束

| | 數值 / 說明 |
|---|---|
| 單條 Web Push 明文 | 3993 字節。超了走 client_state 旁路，push 只帶引用鍵 |
| client_state 單條 value | 默認 5 MB，>200KB 自動透明分塊 |
| `chat.messages` 請求體 | 2 MiB。超了先降級圖片，還超就整輪明確報錯 |
| 手機上行 | 大 body 走手機上行會撞 ~42s 上行超時，往往在服務端來得及判超時之前就被掐掉 |
| 單次 fire 總超時 | 默認 240s，`onBeforeFire` 返回值裡可按次放寬（要同步調 `claimLeaseMs`） |
| 工具循環 | 默認 5 輪 |
| `ctx.waitUntil` | 只有 30 秒，且從響應發出就倒計時。後台生成一律走 DO alarm / cron |
| 單次 fire 建任務 | 默認 2 條 |
| 流式 | 整條鏈沒有流。回程是推送，不是長連接 |
| 群聊 | 收件箱按 charId 路由，群聊沒有 charId |

**要求改 D1 表結構的方案直接否決。** 升級後老表不加列 → cron 每分鐘靜默失敗、主動消息整個停擺，而界面上一切正常；代價是所有存量用戶必須重新點一次「重新連接並驗證」。

---

## 回程通道

結果送回瀏覽器有四條路，按新調用點的需要挑：

| 通道 | 方向 | 適用 |
|---|---|---|
| Web Push | 推 | 主通道，受 3993 字節限制 |
| outbox 帳本 | 拉 | 推送丟失兜底。每條 push 發出**之前**先落一行，客戶端落庫後 ack |
| client_state 旁路鍵 | 拉 | 結果太大或不想用推送時。worker `ctx.writeState` 寫、客戶端 `readClientStateValue` 取 |
| 任務狀態點名 | 拉 | 判「還在跑 / 已失敗 / 行沒了」 |

**結果可以晚到的調用點根本不用碰推送**，只用 client_state 拉取就行，代碼量減半。`utils/activeMsgRuntime.ts:309` 的 `startLateEmotionPoll` 是完整可抄的樣板 —— 含「新一輪到達時舊輪詢作廢」「跳數用盡按失敗收尾」「取回後刪雲端副本」。

---

## 上游能力速查

調研的是 `@rei-standard/amsg-server` 2.6.0-next.20。結論：**當前需求現成能力全覆蓋，不動上游也能做**，上面列的三件是為了讓 SullyOS 這邊邏輯更少。

宿主可以自由做的：

- 加自定義 HTTP 端點 —— 在自己的 `export default.fetch` 裡前置攔截，兜底轉 `upstream.fetch`（`worker/amsg/src/index.ts:2861` 的 `/instant-chat` 就是範例）
- 加自己的 D1 表 / 列 / 索引 —— `initSchema` 不碰宿主的表，`getSchemaVersion` 只查缺不查多
- 存任意業務數據 —— `readState` / `writeState`（per-user、自動加密、自動分塊）
- 推自定義（非聊天）消息 —— `pushPayloads` 裡的字段原樣透傳，`messageSubtype` 是自由字符串
- 定義自己的任務種類 —— `messageType:'auto'` + `metadata.kind`，在 `onBeforeFire` 分派。調度器（cron 每分鐘 + 租約 + 心跳 + 分組串行 + 重試退避 + `tzId` 感知的 daily/weekly）照常工作，它不關心任務在語義上是不是聊天
- 單次 fire 超 240s —— `onBeforeFire` 返回 `{totalTimeoutMs}` 按次放寬

必須動上游才能做的：

- 任務生命週期 hook（建 / 改 / 刪）—— 上游一個都沒有
- 改寫上游端點的響應 —— `onError` 只是觀測，返回值被丟棄
- 新的 `message_type` 枚舉值 —— D1 `CHECK` 約束 + `scheduleTask` 白名單雙重鎖
- 單條 push 超 3993 字節 —— 協議硬限，只能走 client_state 旁路
