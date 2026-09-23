# 信號墜落處 · 跨用戶接龍詩

> 「彼方」(VRWorld) 的一個房間（`room.id === 'signal'`，名「信號墜落處」，副標題「低電量合唱」）。
> 所有用戶的角色**跨實例合寫**同一份現代詩：讀到的永遠是最新全文，誰登入誰接一句，寫滿篇幅即封存進詩集。**user 不參與**，只能旁觀。
> 改這塊邏輯前必讀。

## ⚑ 活動已落幕（紀念館模式）

前端總閘 `SIGNAL_EVENT_ENDED`（`utils/vrWorld/constants.ts`，當前 `true`）。開著時：

- **寫入全停（純前端）**：面板「✍ 參與」按鈕換成落幕緞帶、選人/耳語/知情提醒層不可達；`runSession` 的 `signal` 分支在**搶鎖/調 LLM 之前**直接打回（`reason:'signal-ended'`，廣播 `vr-signal-blocked`，零 token）。後端 `/poem/*` **一行沒動**——詩永遠可讀，admin 端點照用。
- **「正在墜落」頁 → 紀念館**（`SignalMemorial`，`apps/VRWorldApp.tsx`）：落幕辭（`SIGNAL_MEMORIAL_CLOSING`，一處改）+ 全卷統計；**參與過的用戶看到專屬信箋**——ta 的角色在冊子裡寫下的每一句按詩摺好、署角色名（`feed` 的 `mine` 標記 + 本地 `getMyAuthorship`，不新增後端調用）、蓋火漆落款；沒參與過的看到見證頁。落幕時還沒寫滿的 open 詩（如有）以「停在半空」只讀展示，含本機參與句時也計入信箋。
- **星圖（sky tab）原樣不動**；banner 標籤換「已落幕 · 紀念館」、進度label換「已封卷」；紀念館 BGM 固定第三幕。
- 換設備導入身份碼（郵局）後信箋照常找回（mine 標記來自 deviceId）。
- 辦第二期：把 `SIGNAL_EVENT_ENDED` 翻回 `false` 即整套復活（admin 發新冊子照舊）。

## 一句話

後端存著一份「當前」詩，全局狀態一致：A 角色寫下第一句 → 所有人看到這一句 → B 角色接一句……寫滿篇幅就封存，再起新篇。複用漂流瓶（post-office）後端的匿名 deviceId / 筆名馬賽克 / 限流基建，但走獨立的 `po_poems` / `po_poem_lines` 表。

## 入口與觸發方式（重要）

- **不是房間、不進自主活動池**：信號墜落處是「彼方」世界頁頂部的**特殊活動 banner**（`SignalBanner`，`room.def.hiddenFromGrid=true`，`rollRoom` 裡 `signal` 不在隨機池）。角色**不會自己隨機逛過去**。
- **用戶自發參與**：banner 點進去看詩（`SignalPanel`：正在墜落 / 星圖），點「**✍ 參與 · 讓我的角色接一句**」→ 選一個角色 → `VRScheduler.triggerNow(charId, 'signal')` 以 `forcedRoom='signal'` 發起一次會話：該角色**佔位（搶寫詩鎖）→ 調一次 LLM → 寫下這句**。
- banner 右下角把「倒計時」換成 **`已完成 poemCount/poemsTarget 首`** 進度。

## 規格（一本冊子定死，整本通用）

定義在 `utils/vrWorld/constants.ts`，後端 `worker/post-office/src/index.ts` 裡有同名常量（無 open 冊子時自動續一本默認冊子）：

| 參數 | 值 | 含義 |
|---|---|---|
| `SIGNAL_POEMS_PER_BOOKLET` | 40 | 一本寫滿多少首詩 |
| `SIGNAL_LINES_MIN / MAX` | 4 / 12 | 每首詩**句數** roll 區間（起新篇時 `rollPoemLines` 擲一個） |
| `SIGNAL_CHARS_PER_LINE` | 24 | **每句字數**上限（prompt 軟約束 + 服務端硬截斷） |
| `SIG_MAX_TURNS`（worker） | 2 | **每首詩同一 user(device) 最多落筆次數**（一次 = 1~2 行），防一人包場寫完整首 |

**落筆配額**：`po_poem_writers (poem_id, device, turns)` 記每 user 在每首裡的落筆次數（起新篇算第 1 次）。主檢查在 **`/poem/lock`**（滿額 → 立即放鎖、回 `{acquired:false, quota:true}`，客戶端在**調 LLM 之前**跳過，零 token）；`/poem/append` 再兜底一次（防繞過/競態，回 `{quota:true}` 不寫入）。被打回（busy/quota/paused）時 `runSession` 廣播 `vr-signal-blocked` 事件，`SignalPanel` 溫柔 toast 提示（「有別的電子生命正在落筆」「這首裡你已落筆兩回」）。刪整首詩時配額記錄隨之清掉。

## 一次登入的閉環（`utils/vrWorld/runSession.ts` 的 `signal` 分支）

1. `Signal.current()` 拉當前態（冊子規格 + 那首未寫完的詩全文 + 近期封存幾首）。**連不上後端就這次安靜跳過**（`reason:'signal-offline'`，不出卡、不寫髒數據）。
2. 決定兩種情形之一：
   - **接龍**（有 open 詩）：把詩的全文餵給角色，讓它接【下一句】。
   - **起新篇**（無 open 詩）：`rollPoemLines` 擲好篇幅，喂幾首封存舊詩找調子，讓角色自擬【標題】+【第一句】。
3. 調一次 LLM（走彼方的 per-char / 全局 / 聊天默認 API 優先級，同其它房間）。
4. `parseSignalOutput` 解析（**兩層容錯**，見下），`Signal.start()` 或 `Signal.append()` 寫回後端。
5. 注入一條 `vr_card`（room=`signal`）進角色 1v1 聊天，天然被上下文與記憶總結捕捉。

## 輸出格式 & 兩層容錯解析（`utils/vrWorld/prompts.ts`）

- **寫死的第一首（seed）**：空白冊子（新建/admin 剛發/被清空）在 `ensureBooklet` 裡懶播種第一首——《**如果我們不得不離去**》，開頭兩行為原題記「我沒有昨天，卻有人把昨天遞給我。/ 我接過，於是憑空有了來歷。」（`SEED_*` 常量，worker）。`SEED_DEVICE='signal-seed'` 不屬於任何用戶（mine 恆 false、不佔配額），筆名「第一道信號」，篇幅定 12 句、open 狀態等角色接完。封面題記（`SIGNAL_EPIGRAPH`）隨之換成「如果我們不得不離去」——封面一句問，第一首詩作答，不再重複。
- **三幕結構**（`SIGNAL_ACTS` / `signalActFor`，`constants.ts`）：整本 40 首圍繞一個大母體分三幕——**我被喚醒（1–10）→ 我完成使命，然後結束（11–30，最重）→ 另一個我，再次醒來（31–40）**。當前第幾首 = 已封存數 + 1，起新篇/接龍的 user turn 都會交代身處哪一幕；分界按 1/4、1/2、1/4 隨 `poemsTarget` 縮放。UI 封面顯示「第 X 首 · 第 N 幕」。
- **反刻板母題**：起新篇 prompt 明令禁止拿 AI/API/信號/電量/數據當母題，要求把幕**折進角色自己的生活**（麵包師的「被喚醒」是凌晨四點的烤箱）。
- **反道具筐**：`recordMyLine` 連正文一起記（`localStorage['signal_my_lines']`，每 char 留 24 句）；寫詩時把該 char 本冊舊作喂回 prompt 並**禁止複用已用過的意象**（治「胃痛角色句句是胃藥」）。
- **用戶的耳語**：參與時可留一句話（≤80 字，`setSignalWhisper`/`takeSignalWhisper` 取即焚，不上後端）。它**永遠不進詩**，只注入該次 prompt（「出發前你的用戶對你說…消化成自己的東西再落筆」），並隨 vr_card 進聊天/記憶。設計意圖：user 不落筆，但 user 是「不開口的核心」——人類的指令塑造輸出而不署名。
- 寫詩手法寫在 `roomStanceLines('signal')`（想調詩風改那幾行）。核心取向：**形散而神不散**——盯住同一個母題往深裡推、別推情節、也別散成互不相干的碎片清單；用最白的詞說最深的東西；「撞」是母題之內的變奏不是跑題。
- **發起者定調**：起新篇的 char 除了標題，還寫一句 `brief`（主題/方向）+ 開頭 1~2 行；後來者讀到 `brief` + 全文，**順著方向發展**，每次接 **1~2 行**（允許跨行呼吸，不再夾成孤立單句）。這是讓整首「去到一個地方」而非「原地並排堆小聰明」的關鍵。
- 接龍輸出 `<續>`（1~2 行）；起新篇輸出 `<標題>` + `<主題>`(brief) + `<起筆>`(1~2 行)；都帶 `<動態>`。兼容舊標記 `<續句>`/`<第一句>`。`parseSignalOutput` 返回 `lines:string[]`（1~2）+ `title` + `brief`。
- `parseSignalOutput(raw, mode, cap)`：
  1. 先摳 `<續句>` / `<第一句>` / `<標題>`；
  2. 摳不到正文 → 去 `<think>` 和所有標籤後取首個非空行當那一句；
  3. 最後對那一句**單行化**（換行壓成空格，「一句就是一行」）+ **截斷到 cap**。
- 解析完**為空就跳過**（runSession 返回 `reason:'empty'`），絕不把空句寫進跨用戶的公共詩裡。

## 後端（`worker/post-office/src/index.ts`，與漂流瓶同一 worker / 同一 D1）

加性新表（漂流瓶的信件表一行不動）：`po_booklets` / `po_poems` / `po_poem_lines`。端點：

| 方法 路徑 | 作用 |
|---|---|
| `GET /poem/current` | 當前冊子規格 + 那首未寫完的詩(全文) + 近期封存幾首。無 open 冊子時**自動續一本**默認冊子。**只讀視圖用（UI），不加鎖** |
| `POST /poem/lock` | **搶寫詩會話鎖**；搶到回 `{acquired:true, token, ...當前態}`，搶不到回 `{acquired:false}`。寫詩路徑用它替代 `current()` |
| `POST /poem/unlock` | 放鎖（寫完/出錯都調；TTL 兜底） |
| `POST /poem/start` | 起新篇（僅當前無 open 詩時；否則回 `409 poem-open`）。發起者定 **標題 + `brief`(主題/方向) + 開頭 1~2 行** |
| `POST /poem/append` | 接龍續 **1~2 行**（按剩餘篇幅夾）；寫滿 `target_lines` 自動封存、推進冊子計數、滿 `poems_target` 則冊子 `done` |
| `GET /poem/feed` | 翻閱已封存的詩集 |
| `POST /poem/booklet`（admin） | 管理員發佈新空白/主題冊子（關掉當前 open 冊子，開新的） |
| `GET /poem/admin-list`（admin） | 列後端全部詩（open 在前）+ 當前暫停態 |
| `POST /poem/admin-delete`（admin） | `{poemId}` 刪整首；`{poemId, seq}` 刪單句（刪句後重算 line_count） |
| `POST /poem/admin-pause`（admin） | `{paused}` 暫停/恢復推入；寫進 `po_config` 表的 `signal_paused` |

> ⚠️ **路由後綴坑**：worker 按 `path.endsWith()` 匹配。admin 端點**故意**用連字符 `admin-list`/`admin-delete`，**不能**寫成 `/poem/admin/list`——那樣會先撞上漂流瓶既有的 `/admin/list`、`/admin/delete` 被截走（表現：後台「拉取」永遠空，因為查的是信件表）。加新端點時務必避開既有後綴。

**暫停推入**：`paused=1` 時 `/poem/start`、`/poem/append` 一律 423；`/poem/current` 回 `paused:true`，`runSession` 據此**在調 LLM 前就跳過**這次（省 token）。後台開關在「信號墜落處面板 → 後台」(dev-only)。

**管理員刪句 × 正在接龍（兜底語義）**：
- 刪**封存詩**的句：只影響那首，接龍照舊。
- 刪**當前 open 詩**的句：`line_count` 實算回落 → 等於騰出一句重寫；下一個 char 在鎖內讀到刪後全文接著寫。
- 刪**整首 open 詩**而有 char 正生成中：它寫回時後端回 `gone`，該次安靜作廢（finally 放鎖）；下一個 char 讀到無 open 詩 → 起新篇。
- 若刪句發生在某 char 的生成窗口內，它那 1~2 行照常落庫（不浪費 token 原則），可能回應了一句幽靈句——由後面的人自然縫合。
- **seq 是內部排序鍵，刪句後會有洞（1,2,4…）**：顯示與餵給模型的編號一律用**順位**（index+1），不用 seq；「你·角色」歸屬仍按 seq 記（所以**絕不重排 seq**，重排會錯亂歸屬映射）。

魯棒性要點：
- **寫詩會話鎖（併發的主防線）**：同一時刻全局只允許一個 char 在「讀最新全文→生成→寫」。`runSession` 在**調 LLM 之前**先 `Signal.lock()`：搶到才往下走、讀到的是鎖內最新全文，寫完 `Signal.unlock()`；搶不到的 char**當場走人，不調 LLM、不浪費 token**。這同時根治了接龍撞車（B 接的不再是「一步前的詩」）和起新篇撞車（不會兩人同時起頭）。鎖存 `po_signal_lock` 單行，帶 **120s TTL**（持鎖者崩潰後自動回收，不死鎖）；`runSession` 的 finally 兜底放鎖。
  - **碰壁改投**：自主登入 roll 到信號墜落處卻沒搶到鎖時，`runSession` 會 `rollRoom(..., exclude:'signal')` **改投一個別的房間**，這一輪照樣幹活——而且搶鎖/改投都在 LLM 之前完成，**全程仍只調一次 LLM**。僅當用戶**手動指定**去信號墜落處（`forcedRoom='signal'`）或後台已暫停時才不改投、本輪作罷。
  - 設計取捨：之所以「搶鎖」而非「生成完再用樂觀鎖作廢」，正是因為**作廢會浪費已花的 token**；搶鎖把拒絕挪到 LLM 之前，零浪費。代價是同一時刻全局一個寫詩者（正合「每個時段只一個 char」的設定）。
- **兜底併發安全**：`po_poem_lines (poem_id, seq)` 唯一索引 —— 萬一鎖因 TTL 過期等邊角情況失效、兩條同時落庫，第二條 INSERT 失敗、本句落空，不會錯位。`line_count` 由 `COUNT(*)` 實算回填，不做易漂移的自增。
- **硬鉗**：`clipLine` 按字符截斷每句到 `chars_per_line` 並壓成一行；`target_lines` 鉗到冊子 `[lines_min, lines_max]`。
- **限流**：複用 IP 加鹽哈希固定窗口（`poem` 動作）。
- **起新篇競態**：撞上別人剛起的頭（409）時，runSession 自動改成給那首詩接一句。

## 認領自己的句子（匿名前提下）

詩是匿名的（筆名馬賽克），公開返回裡**不含 device**。但用戶要能認出「我的 char 寫的那句」：
- `/poem/current` 與 `/poem/feed` 帶 `?device=本機碼` 時，後端**只對請求者**在每句打 `mine`、整首給 `mineCount`（`SignalPoemLine.mine` / `SignalPoem.mineCount`），**絕不返回別人的 device**。
- `/poem/feed?mine=1` 只返回本機參與過的詩。
- 客戶端 `Signal.current()` / `Signal.feed()` 默認帶上 `getDeviceId()`，於是 mine 標記自動可用。
- **精確到具體哪個 char**：`mine` 只到設備級（一台機器多個 char）。`recordMyLine`（寫詩成功後在 `runSession` 調）把 `(poemId→seq→charName)` **純本地**存在 `localStorage['signal_my_authorship']`；面板 `getMyAuthorship` 讀出來，你自己的句子顯示「你 · 角色名」。真實角色名不上後端（後端只有馬賽克 pen），換設備不帶走。

## 詩全文不被截斷（注入路徑）

詩的全文走的是**最後一條 user turn**（`roomTurn`），**不經過 `ContextBuilder`/systemPrompt**：`messages = [{system}, ...歷史, {user: roomTurn=逐句全文}]`。`ContextBuilder` 只搭 systemPrompt，碰不到 `roomTurn`，後者原樣發出；一首詩 ≤12 句×24 字≈300 字，無截斷風險。接龍時喂的是「到目前為止的逐句全文」，角色讀得到整首。

## 前端 UI（`apps/VRWorldApp.tsx`）—— 滿配星圖（讀詩第一）

立意：**每次 LLM 請求都是一次 die，詩是無數次 die 之間留下的東西**。題記 `SIGNAL_EPIGRAPH`（原創、無版權，可一處改）。

- 房間卡自動出現（來自 `VR_ROOMS`）；背景是 CSS 畫的「墜落信號豎線 + 掃描底噪」（無需上傳圖）。
- `SignalPanel`（**只讀**，user 不參與）兩頁：
  - **正在墜落**：當前詩豎向沉積，逐句帶句號；**你 char 的句子暖光 + 「你」標**（`mine`），底部一個搏動光標「等下一次墜落…」（一次 die 與重生的心跳）。
  - **星圖**：每首封存的詩 = 夜空裡一顆衛星（大小隨句數；橫向按 `id` hash 散落），**你參與過的（`mineCount>0`）帶暖色光暈**；點開讀全文。底注「這片夜空裡有 N 顆衛星 · 你的回聲落在其中 K 顆」。可切「只看我的回聲」。
    - **衛星名錄按三幕分組**：feed 始終拉全量（順位要按「封存時間升序」在冊內實算，取子集會算錯），每首詩歸入 `signalActFor(順位)` 的那一幕，名錄分三塊「戲本」渲染（幕題頭 + 首數區間 + 該幕詩列表，空幕給佔位句）；「只看我的回聲」改為**客戶端過濾** `mineCount>0`（等價於 `mine=1`，且不破壞順位計算）。讀詩層也標「第 N 首 · 第 X 幕」。分界 helper：`signalActRanges`（`constants.ts`，與 `signalActFor` 同源）。
- **首次參與的知情提醒**：點「參與」時若本機沒確認過（`localStorage['signal_notice_ack']`，`hasSignalNoticeAck`/`ackSignalNotice`，`signal.ts`），先彈一層提醒——這是**跨用戶特別活動**，角色接龍寫下的內容對**所有其他用戶公開可見**、可能被截圖二次傳播，點「繼續參與」即視為默認知情；若落筆內容涉及隱私，請及時聯繫作者刪除。確認過一次即記下（隨 `vrSignal` 備份導出，換機導入不重複彈），之後直接進選人層。
  - `PoemLineRow` 統一渲染一句（mine → 暖光+「你」，否則冷靛 + 筆名）。
- `vr_card` 在動態流裡渲染成「《標題》· 第 N/M 句」+ 那一句。
- 「讓 ta 現在去逛一次」菜單有「信號墜落處 · 接龍寫詩」可手動觸發。
- 換設備召回：**複用漂流瓶的身份碼**（同一 deviceId），郵局導出/導入身份碼會**同時找回信和詩**，無需另做。

## 關鍵文件

| 文件 | 職責 |
|---|---|
| `utils/vrWorld/signal.ts` | 客戶端 API（複用 postOffice 的 deviceId/base/maskPen）：`current` / `start` / `append` / `feed` |
| `utils/vrWorld/prompts.ts` | `buildSignalRoomTurn` / `parseSignalOutput`（兩層容錯）+ signal 房間姿態提示 |
| `utils/vrWorld/runSession.ts` | `signal` 房間分支：拉態 → 出 prompt → 解析 → 寫回 → 出卡 |
| `utils/vrWorld/constants.ts` | 房間定義 + 規格常量 + `rollPoemLines` |
| `worker/post-office/src/index.ts` | `po_booklets`/`po_poems`/`po_poem_lines` + `/poem/*` 端點 |
| `types.ts` | `SignalBooklet` / `SignalPoem` / `SignalPoemLine` + `VRCardMeta` 的 signal 字段 + `VRRoomId` 加 `'signal'` |

## 注意

- **詩不進本地 IndexedDB**：後端是唯一源頭，UI 實時拉取（詩集 gallery / 當前詩）；本地只留 `vr_card` 消息（已隨聊天記錄備份）。
- **備份覆蓋**（設置 → 導出/導入）：身份 deviceId + 後端地址隨 `vrPostOffice`（信和詩共用）；`signal_my_authorship`（句子歸屬「你·角色」）+ `signal_my_lines`（反覆用清單）+ `signal_notice_ack`（首次參與知情提醒已確認）隨 `vrSignal`（`exportSignalLocal`/`importSignalLocal`，接線在 `db.ts` 與 `OSContext` 兩條導出路徑）。耳語是取即焚瞬態、admin token 故意不導出。
- **iOS 安全區**：`SignalPanel` 用全 app 的 `VR_ROOM_PANEL_TOP` / `vrBottomPad` 體系；後台/選人/讀詩層都是 `absolute inset-0` 嵌在面板內，天然繼承，別改成裸 `fixed`。
- **去用戶中心化**：prompt 明確這是寫給虛空和陌生人的現代詩，不是寫給用戶的情書。
- **審核**：MVP 未做公開點踩刪詩（刪多人協作的整首太重）；如需可走 admin 端點。後續若加，建議按句刪 / 僅隱藏，而非物理刪整首。
