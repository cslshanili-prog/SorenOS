# 預設 App：獨立的預設庫，線上線下共用

> 狀態：設計稿（2026-11-14），還沒開工。Liora 已定：照建議做獨立 App、條目打場景標籤、綁定只管預設＋正則、功能條目可以關但要提醒、分三批。

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
- 劇情預設：`story_theater_presets` 每份轉成新格式（`marker` → `slot`、`section` → `groups`），`scenes: ['story']`，寫進 `meeting_presets`；劇情的 `presetId` 改指新的 id。舊表**先留著不刪**（驗證一版沒問題再清）。內建的「夜場放映」也轉一份內建。
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
