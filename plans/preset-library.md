# 預設 App：獨立的預設庫，線上線下共用

> 狀態：第 1～3 批全部做完（2026-11-14）：預設 App、私聊（含雲端）、電話、群聊。實況見文末。之後另開 AI 助手。Liora 已定：照建議做獨立 App、條目打場景標籤、綁定只管預設＋正則、功能條目可以關但要提醒、分三批。
>
> **開工後改的一條**：劇情預設**不搬**進通用格式（見第 6 節）。劇情劇場的引擎靠固定的條目 id（`nmj-v64…`）跑分區、快捷選項、小劇場、旁白，轉成通用格式等於重寫引擎。所以預設 App 一個地方放兩種：通用預設（ST 格式，見面現在用、線上之後用）和劇情專用預設（原格式、原編輯器，只給劇情）。

## 1. 為什麼

現在 Soren 有**兩套**預設、線上完全沒有：

| 場景 | 現在 | 存在哪 |
|---|---|---|
| 線下・見面（單人） | 見面預設（ST 格式，匯入 ST、正則、內建可複製；`utils/meetingPreset/`） | `meeting_presets` 表；每角色 `dateMeetingPresetId` |
| 線下・劇情劇場（多人） | 劇情預設（`sullyos.story-preset`，自己的製作器、分區） | `story_theater_presets` 表；每條劇情 `presetId` |
| 線上・私聊／群聊／電話 | 沒有，全是程式裡拼的內建提示詞 | — |

很多同類產品都讓用戶匯入自己的預設，而且照樣有表情包、轉帳、送禮、拉黑這些功能。用戶手上有大量 ST 預設，想在線上也用。

## 2. 參考 FloraOS

FloraOS 的做法（`lib/builtin-preset.ts`、`lib/llm-prompt-assembler.ts`、`components/settings/binding-manager.tsx`）：

- **功能本身就是預設裡的條目**：內建預設是一份 ST 格式，除了文風、角色、世界書的佔位，聊天工具、輸出格式、語音視訊格式、群聊格式、朋友圈、日記……都是一條條條目（70 多條）。
- **條目打場景標籤**（`chat`、`group_chat`、`moments`、`story`…），組裝時只拿當前場景的。一份預設通吃所有場景。
- **綁定**：全域預設 → 每個 App 的預設 → 每個角色 × 每個 App 覆蓋（連 API、語音、世界書、正則一起綁）。
- 功能條目看得到、可以關、可以換。

它的缺口：匯入一份普通 ST 預設，裡面沒有那些功能條目，功能就沒了說明。

## 3. 定案

1. **獨立「預設」App**（桌面，跟世界書並排），一個庫放所有預設：匯入 ST、從內建複製、開關排序每一條、正則。
2. **條目打場景標籤**：`chat` 私聊、`group` 群聊、`call` 電話、`date` 見面（單人）、`story` 劇情（多人）。預設本身也標「適用場景」（篩選、選單用）。
3. **內建預設拆成條目、看得到**，三種條目：
   - **文風條目**：可以改、可以關（例如「訊息長短與節奏」「口吻」）。
   - **資料佔位**：人設、世界書前後、角色描述、記憶、即時狀態、聊天記錄……內容由 Soren 填（見面現在就是這樣）。
   - **Soren 功能條目**：表情包、轉帳、送禮、拉黑、私下找人、主動消息格式、語音標籤、HTML 卡片、思考鏈……內容由現有程式產生（依角色設定、開關決定有沒有），標「Soren 功能」。
4. **匯入普通 ST 預設會自動補功能**：預設裡沒擺的資料佔位、功能條目，組裝時自動補在預設位置（見面現在對 Soren 佔位就是這樣）。所以匯入日月西這類預設，文風照它，表情包、轉帳照常。用戶可以把功能條目拖到想要的位置。
5. **功能條目可以關**（FloraOS 也可以），關的時候提醒後果（「關掉後角色不會再用表情包」）。明確關掉的不自動補。
6. **綁定只管預設＋正則**：正則跟著預設走（照 ST，預設內嵌 `regex_scripts`）。API 已經是每角色、世界書剛做了全局，這次不動。
   - 每個場景一份「預設用哪份」（App 裡設）；沒設就是那個場景的內建。
   - 角色可以覆蓋（每個場景各自）；見面現在的 `dateMeetingPresetId` 就是「角色 × 見面」的覆蓋，照搬。
   - 劇情劇場是每條劇情選一份（照舊），沒選就用「劇情」場景的預設。

## 4. 資料結構

沿用 `meeting_presets` 表（已進完整備份），文件升版：

```ts
interface PresetDoc {            // 原 MeetingPresetDoc 往上擴
  schema: 'soren.preset';        // 舊的 'soren.meeting-preset' 讀進來自動升
  version: 2;
  name: string;
  scenes: PresetScene[];         // 適用場景（篩選、選單用）
  generation: …;                 // 照舊
  prompts: PresetPrompt[];       // 照送出順序
  regexScripts: …;               // 照舊（ST 欄位名）
  groups: …;                     // 介面分組；劇情預設的「分區」轉成這個
  assistantPrefill?: string;
}
interface PresetPrompt {         // 原 MeetingPresetPrompt＋
  scenes?: PresetScene[];        // 沒有＝跟著預設的適用場景
  slot?: PresetSlot;             // ST 佔位、Soren 資料佔位、Soren 功能（'feature:xxx'）
  locked?: boolean;              // 內建的功能條目：內容不能改（可以關、可以移）
}
type PresetScene = 'chat' | 'group' | 'call' | 'date' | 'story';
```

綁定存在哪：
- 場景預設：`presetBindings: Partial<Record<PresetScene, string>>`（跟 OSTheme 或 apiConfig 同層的全域設定，進備份）。
- 角色覆蓋：`CharacterProfile.presetOverrides?: Partial<Record<PresetScene, string>>`；`dateMeetingPresetId` 讀的時候當成 `presetOverrides.date`，改過一次就寫新欄位（同開場白的做法）。

## 5. 組裝

- 一條共用的組裝器（現在 `assemble.ts` 往上擴）：拿「場景＋預設＋各佔位的內容」，照預設順序拼；資料佔位、功能條目沒擺的照預設位置補；條目不屬於當前場景的跳過。
- **各場景的佔位內容由現有程式產生**，不重寫邏輯：私聊就是把 `ChatPrompts.buildSystemPrompt` 現在拼的每一塊（核心設定、關係、拉黑、私下找人、即時狀態、群聊背景、Chat App 規範、語音、收尾鋼印……）拆成一個個佔位的產生器。沒選預設＝內建預設＝跟現在送出的一字不差（要有測試鎖住）。
- **快取順序**：私聊現在分 `stable`／`volatileState`／`recencyTail` 三段，是為了提示詞快取和「收尾鋼印要最後讀到」。內建預設照這個順序排；用戶自己排亂了快取變差，不擋，但「收尾」那條預設鎖在最後。
- **雲端**：主動消息 2.0 的模板是手機上 `buildSystemPrompt(forFirePack)` 組好再上雲，預設接在這一步，雲端自然跟著；換預設、改預設要把用到它的角色標髒重組。

## 6. 搬家（第 1 批）

- 見面預設：原表原記錄，`scenes: ['date']`，schema 升版。角色的 `dateMeetingPresetId` 照讀。
- ~~劇情預設：轉成新格式寫進 `meeting_presets`~~ → **改了**：劇情預設留在 `story_theater_presets`、格式和編輯器照舊（引擎綁死固定條目 id），預設 App 裡另列「劇情專用」。通用預設之後若要給劇情用，再另外設計怎麼對上劇情引擎的分區。
- 舊的入口保留成捷徑：見面設定、劇情編輯器的預設選單照舊能選，旁邊「管理」跳到預設 App。

## 7. 匯入匯出

- 匯入：ST 預設（現有 `stImport.ts`，`regex_scripts`、分組照收）、Soren 預設、舊劇情預設格式。匯入時問「適用場景」（預設勾一個合理的：ST 預設預設勾見面／劇情）。
- 匯出：ST 格式（`stExport.ts`，Soren 功能條目匯出成普通條目或略過，選一個，見待定 2）、Soren 格式（完整）。
- 簡繁：匯入的預設、正則**不轉繁體**（正則靠簡體標籤匹配，照見面現行規則）。

## 8. 分批

| 批 | 內容 |
|---|---|
| **1** | 預設 App（庫、匯入匯出、編輯：條目開關排序、場景標籤、正則）、資料升版、見面＋劇情搬進來、場景綁定與角色覆蓋（線下兩個場景接上）、舊入口變捷徑 |
| **2** | 私聊：`buildSystemPrompt` 拆成佔位產生器、內建私聊預設（一字不差測試）、功能條目、自動補位、雲端模板跟上、角色覆蓋 |
| **3** | 群聊、電話（電話要短句，內建電話預設的文風條目會特別寫明；ST 長篇預設套進電話效果通常不好，選單上提醒） |

之後另開：**AI 助手**（參考 FloraOS「小卷」，工具呼叫＋每個寫入工具有格式檢查、寫入前給你看、快照可還原），等預設 App 做完才有地方寫。

## 9. 待定

1. **App 名字和圖示**：「預設」？跟世界書放同一頁。
2. **匯出成 ST 時 Soren 功能條目怎麼處理**：(a) 略過（ST 用不到）(b) 匯出成普通文字條目（內容是當下產生的文字）。建議 (a)，ST 那邊沒有這些功能。
3. **場景標籤要不要讓用戶在條目層級改**：FloraOS 可以。建議第 1 批先只在預設層級勾、條目層級第 2 批做私聊時再開（那時才真的有跨場景的條目）。

## 第 1 批實況（2026-11-14）

**做了什麼**

- **預設 App**（`apps/PresetApp.tsx`，`AppID.Presets`，桌面名「預設」，圖示 `SlidersHorizontal`，跟世界書並排）。
  - 上方「每個場景預設用哪份」：見面（內建規則＋含見面場景的通用預設）、劇情（劇情預設；沒設＝新劇情用第一份）；私聊、群聊、電話灰著，寫「之後開放」。
  - 篩選：全部／見面／劇情。內建兩列（見面 · 內建規則「複製一份」、劇情 · 夜場放映「看看」），下面是自己的。
  - 每列「⋯」：管理（通用→`MeetingPresetManager`；劇情→`StoryPresetMaker`，外面要包 `StoryTheaterThemeProvider` 才讓得出頂端安全區）、設為／取消場景預設、複製一份、匯出（通用→ST json；劇情→原格式）、刪除（通用的刪掉會清掉角色身上指著它的 `dateMeetingPresetId` 和場景預設）。
  - 右上匯入：`schema: 'sullyos.story-preset'`（含 PNG 分享卡）進劇情，其它當 ST 預設進通用。右上「＋」：從見面內建複製／從劇情內建複製／空白劇情預設。
- **場景綁定**（`utils/presetBinding.ts`）：
  - `UserProfile.presetSceneDefaults`：每個場景一份 id；`MeetingPresetDoc.scenes`（沒寫＝`['date']`）。
  - 見面用哪份：`resolveDatePresetId` = 角色自己選的（`'builtin'` 明確指內建）> 見面場景預設 > 內建。角色 `dateMeetingPresetId` 沒設就是「跟著預設 App」。舊資料場景預設是空的，行為跟以前一樣。
  - 劇情：新劇情預設選 `defaultStoryPresetId`（場景預設在清單裡就用它，不然第一份）；已經選過的劇情照舊。
- **舊入口變捷徑**：見面設定的預設區多一列「跟著預設 App · 目前：X」，內建規則改成寫 `'builtin'`，底下連到預設 App；`DateApp` 載入預設照解析走，場景預設改了即時換。
- 埋點：`设定场景预设`、`导入预设`、`新建预设`（`docs/analytics.md`）。

**還沒做（第 2 批起）**：條目層級場景標籤、Soren 功能條目、私聊／群聊／電話接上、雲端模板、角色每個場景各自的覆蓋（現在只有見面一個場景，沿用 `dateMeetingPresetId`）。

**測試時的坑**：Playwright 在這個環境 `setInputFiles` 給中文檔名的檔案會靜默設不進去（`files.length` 是 0、沒有 change 事件），測試檔用英文檔名。

## 第 2a 批實況（2026-11-14）：私聊接上預設

Liora 定的三件事：匯入的預設用在私聊時 Soren 的文風**不補**（聽預設的）；角色可以在聊天設定裡自己選；雲端（主動消息 2.0、即時對話）拆到 2b。

**私聊提示詞分段**（`utils/chatPrompts.ts`）

- `buildSystemPromptParts` 多回 `segments` 和 `coreSections`。穩定段照接的順序是 `charWorld → relationship → interact → lifeContext → format → talk → emoji → quote → actions → voice`（`CHAT_STABLE_SEGMENT_ORDER`），接起來就是 `stable`；`live` 就是 `volatileState`；`expression + anchor` 就是 `recencyTail`。
- 段只是同一串字的切法，內建送出一字不差：改之前拿舊版本做過 36 種組合的 A/B（穩定段、收尾全同；實時狀態只差在新聞本來就隨機排），長期由 `utils/chatPrompts.segments.test.ts` 鎖「接回去等於送出的那串」。
- 三段文風搬到 `utils/chatPresetText.ts`（`CHAT_STYLE_TALK`／`EXPRESSION`／`ANCHOR`，名字寫 `{{char}}`／`{{user}}`），`ContextBuilder` 的表達底線抽成 `ANTI_FILLER_BLOCK`；內建照舊用同一份字。
- `ContextBuilder.buildCoreContextWithSections` 同時交出角色塊的各段，`buildCoreContext` 包它。

**組裝**（`utils/chatPresetSession.ts`，用的是見面那顆 `assembleMeetingPreset`）

- 新的 Soren 佔位（`ChatSorenSlot`）：資料 `chatRelation`（稱呼關係＋印象＋你身邊的人）、`chatLife`（日記與彼方）、`chatLive`（實時狀態＋點單／語境分析／協同文件櫃）；功能 `chatFormat`、`chatEmoji`、`chatQuote`、`chatActions`、`chatInteract`、`chatVoice`、`chatModes`（雙語、HTML、思考鏈、MCP）。ST 佔位照見面的拆法填，記憶 `memory` 是房間門牌＋記憶庫（召回、時間、情緒在實時狀態裡）。
- 預設沒放的資料和功能自動補：實時狀態補在聊天記錄後面，其餘照固定順序補在前面；**預設裡有但關掉的＝明確不要，不補**（這條也改了見面：以前見面關掉的 Soren 佔位還是會被補回去）。文風不補。
- 送出前相鄰的 system 併成一則，結構跟內建一樣是「前段＋聊天記錄＋後段」；帶圖的聊天記錄原樣送（不跑正則）。
- 「私聊 · 內建」寫成一份文件（`buildBuiltinChatPresetDoc`）給人複製：ST 佔位、Soren 資料、功能、四條文風文字、聊天記錄、實時狀態、收尾。內建本身不走組裝器。

**接上**（`utils/chatRequestPayload.ts`）

- 用哪份：`resolveChatPresetId`＝角色的 `chatPresetId`（`'builtin'`＝明確內建）> `presetSceneDefaults.chat` > 內建；選的被刪了退回內建。
- 本地私聊（前台、背景延遲回覆）都走這裡；`timelyByWorker`（即時對話）這批照內建。
- 模式塊另外記一份給 `chatModes`，實時狀態後面接的另記給 `chatLive`；`volatileTailIndex` 在預設模式指向放實時狀態的那則。`flags.chatPresetActive` 標這輪有沒有照預設。

**畫面**

- 預設 App：場景預設多了「私聊」；篩選多了私聊；「私聊 · 內建」可以複製；ST 預設匯入預設勾私聊＋見面，「⋯ → 適用場景」可以改（取消某場景時順便取消它在那裡的場景預設）；刪除也清角色的 `chatPresetId`。
- 聊天設定 →「場景與玩法」第一列「預設」：跟著預設 App（顯示目前是哪份）／內建／某一份，按「完成」存。
- 預設編輯頁：Soren 功能條目寫「內容由 Soren 照角色設定產生」，關掉時在條目下面用橘字講後果（`CHAT_FEATURE_OFF_WARNING`）。

**還沒做**：~~雲端兩條路（2b）~~（見下）；預設的生成參數（溫度等）私聊還不吃；預設的「只改顯示」正則還沒套到聊天氣泡；條目層級的場景標籤；群聊、電話（第 3 批）。

## 第 2b 批實況（2026-11-14）：雲端兩條路

- **即時對話**：本來就是把本地組好的那串 messages 交給 worker，worker 只在最後補一則時效段（`buildInstantTimelyBlock`）、在用戶資料段補假日那行，不碰前面的結構。所以拿掉「即時對話照內建」那道閘就接上了；用戶資料段只有預設擺了 `personaDescription` 才在，沒擺的話 worker 照舊單獨補一則假日。
- **主動消息 fire_pack**：模板的【角色系統設定】要的是一整段字。選了預設的角色改呼叫 `buildSystemPromptParts`（`forFirePack`），用 `renderChatPresetSystemText` 照預設組一次（沒有聊天記錄），每則的字照順序接起來；聊天記錄之後的條目（破限之類）接在最後。沒選預設照舊呼叫 `buildSystemPrompt`，一字不差（原本那些測試都還樁著它）。
- **什麼時候重打包**：角色改 `chatPresetId`（`updateCharacter` 本來就會打髒）、改場景預設（`updateUserProfile` 本來就全部打髒）、**預設內容改了**（新加：OSContext 聽 `MEETING_PRESET_UPDATED_EVENT`，只打髒有用自訂預設的角色，走 `markAmsgStateDirtyForAll` 讓每條關係線各自重傳）。
- `loadChatPresetDoc`：角色沒選、場景也沒設就不碰 DB（每一輪都會走這裡）；套了身份卡的用戶資料是從主資料展開的，`presetSceneDefaults` 照樣帶著，不用另讀。
- 測試：`utils/activeMsgClient.preset.test.ts`、`utils/chatRequestPayload.preset.test.ts`。

## 第 3a 批實況（2026-11-14）：電話

Liora 定的：電話用「電話」場景預設，角色可以在聊天設定「預設」下面另選一份「電話預設」；群聊整份照套、導演格式鎖最後、每個群在群設定裡選（3b）。

- **電話提示詞搬家**：`buildCallPrompt`／`currentVoiceActingGuide` 從 `apps/CallApp.tsx` 搬到 `utils/callPrompt.ts`。`buildCallPromptParts` 回 `{ text, segments }`：`text` 就是內建送的那一串，`segments` 是 `scene`（你是誰、電話那頭是誰、此刻在做什麼）、`talk`（`CALL_STYLE_TALK`：不像寫作文、感受對方、回覆長度）、`voiceActing`、`format`（來源標記＋底線）、`voiceLang`、`time`。搬之前拿舊函式做過 A/B（語音／視訊 × 語種翻譯 × 有無角色塊）一字不差，長期由 `utils/callPrompt.test.ts` 鎖「段接回去等於內建」。
- **組裝**（`utils/callPresetSession.ts`）：ST 佔位照見面的拆法填（角色塊用 `buildCoreContextWithSections`，電話不 defer，所以記憶宮殿、情緒、時間在角色塊裡）；Soren 資料沿用 `soren`（印象＋你身邊的人＋固定台詞）、`memory`、`emotion`、`time`（角色塊時間＋電話的【當前時間】）；電話功能是新的 `CallSorenSlot`：`callScene`、`callFormat`、`callVoice`（演出＋語種）、`callVideo`（模型表演、鏡頭情緒、快照說明）、`callModes`（思考鏈）。沒放就補（格式補在最後、最貼近通話記錄），放了關掉不補，文風（說話方式、表達底線）不補。內建電話預設 `buildBuiltinCallPresetDoc` 給人複製。
- **CallApp 接上**：`loadCallPresetDoc`＝角色的 `callPresetId` > `presetSceneDefaults.call` > 內建；`sendChatRequest` 改走 `composeMessages`，選了預設照預設組（快照那輪多帶快照說明、退回純文字那輪不帶），沒選照舊「一則 system＋通話記錄」。
- **畫面**：聊天設定多一欄「電話預設」（提醒長篇預設套電話太囉嗦）；預設 App 場景預設、篩選、適用場景多了電話，「電話 · 內建」可以複製，ST 預設匯入預設勾私聊＋電話＋見面；刪預設也清 `callPresetId`；預設編輯頁的功能條目關掉提醒也涵蓋電話。
- 測試：`utils/callPrompt.test.ts`、`utils/callPresetSession.test.ts`；實機撥了一通電話攔請求（主提示在前、電話場景與語音演出有補、說話方式沒補）。

## 第 3b 批實況（2026-11-14）：群聊

- **抽文風**：導演指令裡「一、群聊的樂子是多元的」＋「二、修羅場硬規則」是 `GROUP_STYLE_ATMOSPHERE`，「四、對話質量」是 `GROUP_STYLE_QUALITY`（`utils/groupChat/prompts.ts`），模板照舊用它們，A/B 一字不差。`withoutGroupStyle` 把這兩段拿掉；「三、U 還是 U」、互動結構、私下找人、格式、JSON 都留著（那是功能，不是文風）。輪流模式的規則很短、多半是格式，不拆。
- **組裝**（`utils/groupPresetSession.ts`）：群聊內建是一則 user 訊息（群場景＋成員檔案＋本輪任務，記錄寫在任務裡）。用了自訂預設：預設條目照順序；`groupScene`（`buildGroupSystemHeader` 的 header）、`groupMembers`（成員檔案塊，輪流模式只有輪到的那位）是 Soren 佔位，沒放就補在記錄前；「聊天記錄」那格放本輪任務（導演模式拿掉兩段文風，圖片照帶，用多段內容送所以不跑預設的正則）；預設沒有記錄格或關掉也照補。最後永遠接一則格式鎖（`groupFormatLock`：導演＝只輸出 JSON 陣列、輪流＝只寫自己的台詞），預設的 assistant 預填不送。`{{char}}` 換成成員名字（「、」接），`{{user}}` 是群裡的你。
- **用哪份**：`GroupProfile.presetId`（`'builtin'`＝明確內建）> `presetSceneDefaults.group` > 內建（`resolveGroupPresetId`、`loadGroupPresetDoc`），導演和輪流兩條路都接。
- **畫面**：群設定多一欄「預設」（`components/chat/GroupPresetSelect.tsx`，選了就存）；預設 App 場景預設、篩選、適用場景多了群聊，「群聊 · 內建」可以複製，ST 預設匯入預設勾全部四個線上線下場景；刪預設也清群的 `presetId`。
- 測試：`utils/groupPresetSession.test.ts`；實機在導演模式送一輪攔請求（預設主提示在前、群場景補上、任務帶記錄、氛圍規則拿掉、JSON 鎖最後），回的 JSON 照常解析成氣泡。

**整體還沒做的**：預設的生成參數（溫度等）線上場景還不吃；「只改顯示」的正則還沒套到聊天氣泡；條目層級的場景標籤；AI 助手。
