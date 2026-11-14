# 聊天紀錄匯入匯出＋ST 角色卡

> 狀態：第 7 節定案（Liora 2026-11-14：照建議，重複匯入改成讓人選）；a、b、c 已做（見第 9 節），下一批 d（匯出）。起因：有人想從別家搬過來，主要是 SillyTavern（酒館）和另一家手機風格的 App。Soren 現在沒有單純的聊天紀錄匯入匯出（只有整台 ZIP 備份、多選轉發、記憶導入），也不能匯入 ST 角色卡。
>
> 已定（Liora 2026-11-14）：ST 聊天匯成**見面故事**（酒館是小說式長段落，不是一人一句的私聊）；一起做 **ST 角色卡 PNG**；圖床的圖**不搬**，匯入頁放一句提示；另一家的 `subtext` 收進思考鏈、`reactions` 不收。

樣本：另一家私聊兩份（8 則、790 則）、群聊一份（64 則）；ST 聊天兩份（各 6 行，同事隨便跑的）。

## 1. 入口

| 匯入什麼 | 在哪 |
|---|---|
| 另一家的私聊 | 私聊右上角齒輪 → 聊天設置 →「匯入聊天紀錄」；訊息列表「＋」也放一個（還沒有這個角色時用） |
| 另一家的群聊 | 群組設置 →「匯入聊天紀錄」；訊息列表「＋」→ 新建群聊時可選「從檔案匯入」 |
| ST 聊天（.jsonl） | 見面 → 故事列表 →「匯入 SillyTavern 聊天」 |
| ST 角色卡（.png／.json） | 神經鏈接 → 新增角色旁「匯入角色卡」 |
| 匯出 | 私聊的聊天設置、見面的故事選單 |

檔案丟進來先**自動認格式**，認不出來就說不支援、列出支援哪幾種。

## 2. 匯入流程（三種共用）

1. 選檔案 → 認格式。
2. **放到哪**：
   - 私聊：選角色（同名的排最前面）或「新建一個」；有好幾條線時選哪條（預設是現在這條）。
   - 群聊：每個發言人照名字對到 Soren 的角色，對不到的讓你選或新建；群可以新建或併進現有的群。
   - ST 聊天：選角色（對不到就先匯角色卡）、選線，新開一場見面故事。
3. **預覽**：幾則訊息、時間從哪到哪、各類訊息幾則（文字／圖片／貼圖／轉帳／語音／系統）、收不進來的幾則和原因；記憶那段可以勾掉不要的。
4. **匯入**：寫進資料庫；每則記下來源和原本的 id（`metadata.importedFrom`）。**同一份再匯一次**，預覽會說「其中 N 則已經匯過」，讓你選：**跳過已經有的**（預設）或**覆蓋**（舊的那幾則換成檔案裡的版本）；選覆蓋時再提醒一次「在 Soren 裡改過、重新生成過的會被蓋掉」。
5. 一句提示：「圖片和貼圖還是連到原本的圖床，那邊刪了或關了就看不到。」

~~匯入的訊息照原本的時間排，夾在既有訊息中間也照時間。~~ 做 b 時改：Soren 的訊息照寫進去的先後（自增 id）排，聊天畫面、提示詞、記憶宮殿都是，所以**做不到夾在中間**。匯到新角色／空的線就是照時間；匯到已經有訊息的線，新的那幾則接在後面（時間照原本的標），預覽會提醒、建議匯到新角色。覆蓋是原地換內容，位置不動。不觸發 AI（不回覆、不總結、不評情緒）；要讓角色接著聊，照常傳一句就好。

## 3. 另一家（JSON）

認法：有 `version`、`exportDate`、`messages`，私聊有 `character`，群聊有 `kind` 和 `group`。

### 3.1 訊息

| 原本 | 進 Soren |
|---|---|
| `sender: me`／`them` | 你／角色；群聊用 `senderName` 對角色 |
| `text`（`content` 是 `{"t","c","tr"}` 包起來的同一句，不另外讀） | 文字 |
| `timestamp`（數字或日期字串都有） | 時間 |
| `replyTo` | 引用回覆 |
| `sticker`＋`stickerMeaning` | 表情貼圖（意思一起帶，角色看得懂） |
| `image`＋`imageSummary` | 圖片訊息＋描述 |
| `transferData`（金額、幣別、備註、狀態） | 轉帳卡 |
| `isVoice`＋`voiceText` | 語音訊息（沒有音檔，只有文字） |
| `type: state` | 大多是**場景旁白**（雙方都有）→ 照誰寫的放、標 `metadata.narration`；只有「你已新增了…」（id `fg_` 開頭）這種才是系統小字 |
| `type: recalled` | 系統小字「你已撤回一條消息」（被撤回的原文不收） |
| `subtext`（沒說出口的心聲） | 收進那則的思考鏈 |
| `translation` | 有而且跟原文不同才收進那則（不另外顯示） |
| `isHtml` 且是那家自己的標籤（如 `<polaroid>`） | 空的不收，有字的收成文字 |
| `reactions`、`oocReview`、`tempo`、`roundId`、`isBackgroundMsg`、`hasThinking`、語音參數 | 不收 |

### 3.2 記憶

- `userFacts`（角色記住的事）：每筆一句，帶分類（`cat`：user 關於你／bond 你們的關係／self 他自己／people 其他人／event 事件）和 `kind`（timeless 不變的／episodic 某次發生的）→ 收成角色記憶，分類寫在標籤上。
- `summaryHistory`（總結）：收**大總結**和**沒被併進大總結的小總結**（`mergedIntoBigSummary` 的跳過），日期照原本的。
- `episodeSummary`：就是最新那篇大總結，跟上一條重複，不收。
- 收進來的記憶標「從別處匯入」。

### 3.3 角色

- 新建時：`name`、`role`（身份）、`description` 放進人設。
- description 裡提到世界書的，那家的世界書沒有一起匯出，要另外搬（拿到樣本再看能不能接）。

## 4. SillyTavern 聊天（.jsonl）→ 見面故事

認法：第一行有 `chat_metadata`，之後每行有 `is_user`、`mes`、`send_date`。

- **一份檔案＝一場見面故事**，標題用檔名（可以改），時間照 `send_date`。
- 每則取**當時選的那一版**（`swipes[swipe_id]`，沒有 swipes 就用 `mes`），其他版本不收。第一則常有好幾版（不同開場白），一樣只收選中的。
- `<thinking>…</thinking>` 拆出來放進那則的思考；其他原樣保留（`<content_format>`、`[仪表开始]` 這些交給你匯入的預設和正則去顯示，見面本來就支援 ST 預設／正則）。
- ~~`is_system: true` 的照系統小字~~ 做 c 時改：ST 的 `is_system` 多半是被隱藏（不給 AI 看）的正常段落，見面也沒有系統小字，所以照誰說的收、標 `stHidden`；`extra.model`、`gen_started` 之類不收。`extra.reasoning`（模型的思考）跟 `<thinking>` 一起收進思考過程。
- 檔案裡**沒有角色卡**（`character_name` 常是 `unused`），角色要先有：對不到時提示先匯角色卡。
- `chat_metadata`（作者註記、變數、世界書計時）不收。

## 5. ST 角色卡（.png／.json）

- **PNG**：讀圖片裡的文字區塊，`ccv3`（V3）優先，沒有再讀 `chara`（V2），內容是 base64 的 JSON。**圖片本身就是頭像**。
- **JSON**：直接讀（`spec: chara_card_v2`／`v3`，也認沒有 spec 的 V1）。

| 卡片欄位 | 進 Soren |
|---|---|
| `name` | 名字 |
| `description`＋`personality` | 核心指令（人設），兩段接起來 |
| `scenario` | 見面的劇情大綱 |
| `first_mes`＋`alternate_greetings` | 見面的開場白（好幾個） |
| `mes_example` | 對話範例（`<START>` 分段照留） |
| `system_prompt`、`post_history_instructions` | 接在人設後面，標明來自卡片（Soren 沒有獨立欄位） |
| `character_book`（卡內世界書） | 建一本世界書、綁到這個角色（走現成的 SillyTavern 世界書轉換） |
| `creator_notes` | 匯入前的預覽裡看得到（「看看作者的話」），**不存**（Soren 角色卡沒有備註欄，也不該進提示詞） |
| `creator`、`tags` | 預覽顯示；`tags` 前四個當角色的簡短描述 |
| `extensions.depth_prompt` | 收成一條深度注入的世界書條目 |
| `extensions.regex_scripts` | 不收（正則跟預設走，在見面的預設裡匯） |

- `{{char}}`、`{{user}}` 照留，Soren 本來就認。
- 匯入完直接打開角色編輯頁，讓你檢查。

## 6. 匯出

- **私聊**：Soren 的 JSON（能完整匯回來，含線、引用、卡片、記憶可選）和 TXT（給人看的：日期分段、`名字 時間：內容`）。
- **見面故事**：TXT（小說式，照段落）和 ST 的 `.jsonl`（搬回酒館用）。
- 範圍：整段，或選日期區間。

## 7. 待定

1. **順序**：建議 a ST 角色卡 → b 另一家私聊／群聊 → c ST 聊天成見面故事 → d 匯出。角色卡先做，因為 ST 聊天要有角色才放得進去，而且單獨就很有用。
2. **userFacts 放哪**：建議收成角色記憶（跟總結同一處、標分類）；記憶宮殿要等你們手動整理或下次自動整理才會進去。還是要直接塞進記憶宮殿？
3. **匯出格式**：私聊 Soren JSON＋TXT、見面 TXT＋ST jsonl，夠嗎？
4. **重複匯入**：~~只跳過~~ → 定案：讓人選跳過或覆蓋，覆蓋前提醒（見第 2 節）。

**定案**：1 照建議 a→b→c→d；2 `userFacts` 收成角色記憶；3 匯出照建議；4 如上。

## 8. 拆法（草稿）

- **a**：PNG 文字區塊讀取、V1/V2/V3 解析、對應表、卡內世界書、匯入頁＋預覽、測試（用公開的範例卡）。
- **b**：另一家格式認定與轉換（純邏輯＋測試，拿三份樣本當測試資料，內容換成假的）、匯入頁（私聊、群聊）、記憶。
- **c**：ST jsonl → 見面故事、思考拆分、swipe。
- **d**：匯出。

## 9. 實況

- **a 已做**：`utils/stCard.ts`（`readPngTextChunks` 讀 tEXt／未壓縮的 iTXt、`extractCardJsonFromPng`〔ccv3 優先、再 chara；base64 或直接 JSON〕、`normalizeStCard`〔V1／V2／V3〕、`characterBookToWorldInfo`〔卡內世界書的 keys／secondary_keys／insertion_order／position 字串／enabled 換成 ST 世界書檔的欄位，extensions 攤開〕、`cardToSoren`）。`components/character/StCardImport.tsx`：神經鏈接兩處「新建鏈接」下面一顆「匯入 SillyTavern 角色卡（PNG／JSON）」；右上角原本的「導入」收到不是 Soren 角色卡的檔，也轉進同一個預覽；預覽列出各欄位進哪裡、同名提醒、作者的話可展開；建立＝`addCharacter`＋`updateCharacter`、世界書 `addWorldbook` 後直接寫進 `mountedWorldbooks`；PNG 本身存成頭像（blobRef）；配角分頁裡匯的就是配角。`system_prompt` 的 `{{original}}` 拿掉。埋點 `导入ST角色卡`。
- **b 已做**：`utils/chatImportPhone.ts`（認格式：私聊有 `character`，群聊 `kind` 是 `group_chat`／`group`；訊息照 3.1 轉，`ImportedMessage` 還沒決定放到哪；`findAlreadyImported`、`toMemoryFragments`）、`utils/chatImportPhoneWrite.ts`（`planImportRows` 決定新增／覆蓋／跳過，`runImport` 一個事務寫完〔`DB.writeImportedMessages`〕再 `DB.patchMessages` 接引用回覆）。匯入頁 `components/chat/PhoneChatImport.tsx`（全螢幕、portal 到 body）：入口是私聊聊天設置「聊天記錄」→「從別的 App 匯入聊天紀錄」（固定這條線）、訊息列表「＋」→「匯入聊天紀錄」（自己選，匯完打開那個聊天）、群組設置「聊天紀錄」（固定這個群）；檔案跟入口對不上（私聊入口匯群聊檔）就改成自己選。私聊：選角色（同名排前、或新建，新建帶名字／身份／簡介）、多條線時選線；群聊：新建群或選現有群、每個發話人對角色（照名字、對不到新建），不在群裡的加進群；群裡你的訊息不寫身份（照群的在場身份）。記憶只收私聊的（勾選、標「匯入·分類」，非主線帶 personaKey）；群聊總結不收。貼圖的 `stickerMeaning` 存 `metadata.stickerName`，`stickerNameFromUrl` 表情庫找不到時用它（私聊、群聊提示詞）。`OSContext.createGroup` 改成回傳新群。埋點 `导入聊天记录`。測試 `utils/chatImportPhone.test.ts`（假資料）。790 則私聊實測約 2.5 秒。
- **c 已做**：`utils/stChat.ts`（`parseStChat`：檔頭可有可無；每則的 `mes` 就是選中的那版，swipes 只算丟掉幾個；`splitThinking` 拆 `<think>`／`<thinking>`／`<thought>`〔沒收尾的後面全算〕，跟 `extra.reasoning` 一起存 `metadata.dateReasoning`，原文存 `dateRaw`、正文其他標籤原樣留；第一則是角色說的標 `isOpening`；`send_date` 認 ISO 和舊版「November 2, 2026 4:43am」；重複用 `send_date＋角色` 當原本的 id；`stChatTitle` 檔名當標題、拿掉 ST 的時間戳）。重複判定改成「來源:id」（`importedKey`），另一家和 ST 共用 `planImportRows`／`runImport`。匯入頁 `components/date/StChatImport.tsx`：見面記錄（某個角色、這條線）頁首「匯入 SillyTavern 聊天（.jsonl）」；新故事不拿走角色身上「下一場」的大綱和時間；沒有進行中的故事時預設設成進行中（下次見面「繼續上次」就接著），有的話收進已完結；同一份再匯一次會找到原本那場，選「只補上新的」或覆蓋；檔案裡的角色名跟這個角色不同會提醒；ST 本機的圖帶不過來，預覽說幾張。
