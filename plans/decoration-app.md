# 裝扮 App（取代桌面的氣泡工坊）＋ Sore 收檔案

> 狀態：定案，分批做（2026-11-15）。起因是同事試用時碰到的三件事，見第 1 節。

## 1. 現在的問題

1. **Sore 收不了檔案**：同事想把手上的 CSS 檔丟給 Sore 請它改佈局，附件鈕只收圖片（`apps/AssistantApp.tsx` 的 `accept="image/*"`）。另外 Sore 看不到聊天裝扮的大半：這個角色穿哪套氣泡、佈局數值、背景、提示音都讀不到，只讀得到白框和氣泡主題的 CSS。
2. **聊天裡的「＋→聊天裝扮」只有半個螢幕**（`components/chat/ChatDecorationPanel.tsx`）：
   - 能調的範圍很小。
   - 鍵盤一彈起來整個面板就滑不動，看不到正在改的欄位。
   - CSS 框很小，也沒辦法放大。
3. **東西散在兩處，要跳來跳去**：
   - 氣泡要到桌面的「氣泡工坊」（`apps/ThemeMaker.tsx`）做。
   - 佈局、背景、聲音、白框只能先點進某個角色的聊天，再從「＋」進去改。連全局默認也一樣。
   - 「整套存成預設、再套給誰」其實已經有了（裝扮面板的「預設」分頁），但藏在半窗的第六個分頁，幾乎沒人找得到。

## 2. 大方向

- 桌面的「氣泡工坊」換成 **「裝扮」App**，全螢幕。氣泡、佈局、背景、聲音、白框 CSS 都在這裡做。
- 核心是 **模板**：一套佈局＋氣泡＋背景＋聲音＋CSS 存成一份，再指定給全局默認、角色或群。
- 聊天裡的「＋→聊天裝扮」改成快捷入口（細節見第 6 節）。
- Sore 那頭：
  - 收文字檔（.css／.txt／.json）。
  - 能讀「某個聊天現在穿什麼」。
  - 能改裝扮，但只出提案（細節見第 7 節）。

## 3. 資料

### 3.1 模板（`DecorationTemplate`）

```ts
interface DecorationTemplate {
  id: string;
  name: string;
  layout?: DecorationLayout;        // 沿用 utils/chatDecoration.ts 的 LAYOUT_DEFAULTS 白名單
  bubbleThemeId?: string;           // 指向氣泡主題（ChatTheme），不內嵌
  background?: { image: string | null; style: OSTheme['chatBackgroundStyle'] };  // image 存 blobref
  sound?: { src: string; volume?: number } | null;
  css?: string;                     // 白框 CSS（可帶 @sully-sound 綁聲音，跟現在一樣）
  updatedAt: number;
}
```

- 存一張新的資產表 `decoration_templates`，進備份。
- 模板沒填的部分＝**這項不管**：套用時不動對方原本的值，維持跟現在「預設只勾部分項目」一樣的語意。
- 匯入匯出仍用現在的 `sullyos-chat-decoration` v1 檔（氣泡內嵌、圖片打包成 data URL）。
  - 匯入時：氣泡存成一套自訂氣泡主題（已有一模一樣的就直接用那套），圖片轉成 blobref，再存成模板。
  - 匯出時：把參照到的氣泡主題和圖片打包回去。

### 3.2 誰用哪個模板

- 角色：`CharacterProfile.decorationTemplateId`
- 全局默認：`OSTheme.decorationTemplateId`
- 群：`GroupProfile.decorationTemplateId`

### 3.3 渲染路徑不動：套用＝寫穿

聊天畫面、群聊、預覽、Sore 讀的欄位都**不改**，照舊讀這幾個：

- `char.chatAppearance`／`chatFineTune`／`bubbleStyle`／`chatBackground`／`chatSound`／`chromeCustomCss`
- `theme.chat*`

模板只是「寫進這些欄位的來源」：

- 指定模板給某個聊天時，把模板內容寫進那個對象的欄位，並記下 `decorationTemplateId`。
- 改模板存檔時，把所有用這份的對象重寫一次（全在本機 IndexedDB，量不大）。
- 好處：不用動 Chat／GroupChat 那一大片讀取邏輯，舊資料也不用遷移。

### 3.4 舊資料

- **沒有模板的聊天**：現在角色身上已有的專屬設定，狀態就叫「自訂」，什麼都不搬。
  - 在 App 裡可以直接編輯「這個聊天的自訂」，也能「存成模板」。
- **舊的整套預設**（`chat_decoration_presets_v1`）：第一次打開 App 時搬成模板。
  - 內嵌的氣泡存成自訂氣泡主題（跟已有的一模一樣就不重複存）。
  - 舊的鍵保留不刪。

## 4. 裝扮 App 的畫面

### 首頁（三段）

1. **正在用**
   - 全局默認：一行，寫出用哪個模板，或「自訂」。
   - 每個角色、每個群各一行：「跟著全局／模板 X／自訂」。
   - 點一行可以換模板，或進去編輯它的自訂。
   - 小號、下戲的角色照慣例藏起來。
2. **我的模板**
   - 卡片列表，每張有縮圖預覽和「N 個聊天在用」。
   - 有「＋ 新模板」和「匯入」（沿用現在的檔案／圖片匯入識別）。
3. **氣泡主題**
   - 列出所有氣泡主題，點進去就是原本的氣泡工坊編輯器。
   - `ThemeMaker` 整個嵌進來，只拿掉它自己的頂欄和「套用給角色」，因為那件事改由模板和「正在用」管。

### 編輯頁（模板或某個聊天的自訂共用同一個編輯器）

- 上半是預覽，下半是五個分頁：佈局、氣泡、背景、聲音、CSS。
- **預覽**：用協同工作那套假資料聊天頁（Sore 預覽也用它）。
  - 編輯某個角色的自訂時，帶上那個角色的名字和頭像。
  - 可以收起預覽，讓編輯區佔滿全螢幕。
- **氣泡分頁**：選一套氣泡主題，或「＋ 做一套新的」，進氣泡編輯器做完回來會自動選上。
- **CSS 分頁**：
  - 小框旁有「⤢ 全螢幕」，點了蓋滿整頁，高度跟著 `visualViewport` 走，鍵盤彈起來也看得到游標那行。
  - 「請 Sore 幫忙」照舊。
- **頂欄**：
  - 改模板時寫「這份有 N 個聊天在用，存了它們都會跟著變」。
  - 只有按「存」才寫，有改沒存要離開時會問。

### 從模板指定給誰

- 模板卡片上有「指定給…」，勾全局、角色、群，存了就寫穿。
- 模板卡片上有「複製一份」：原地多一份「名字（副本）」，誰也沒指定，改完再指定。
- 「正在用」那裡逐行換也行，兩邊是同一件事。

## 5. 群聊

群目前只有這幾項自己的設定：白框 CSS、提示音、我的氣泡（`userBubbleThemeId`）。佈局和背景跟著全局。

- 模板指定給群時，只寫群吃得到的部分，其餘不動。
- 「正在用」那一行會註明「群只套 CSS、聲音、我的氣泡」。

## 6. 聊天裡的「＋→聊天裝扮」

改成「換模板」的小面板：
- 列出模板（縮圖＋名字），點一下就換上，聊天背後馬上看到真實效果；有「跟著全局」一格。
- 不放任何輸入框，鍵盤問題自然沒了。
- 底下一個「到裝扮 App 編輯 →」，直接打開 App 停在這個聊天那一行；從那邊返回會回到這個聊天。
- 這個聊天是「自訂」的時候，第一格顯示「自訂（目前的樣子）」，換別的模板前會問一句（自訂的內容會被蓋掉，可以先存成模板）。

## 7. Sore

- **收文字檔**：
  - 附件鈕改收 `image/*,.css,.txt,.json`。
  - 文字檔讀成字串，以「附件：檔名」區塊接在那則訊息後面，單檔上限 60k 字，超過就截斷並註明。
  - 歷史裡跟圖片一樣，只送最近 2 則帶附件訊息的全文，更舊的換成「附了 xxx.css（N 行），太舊沒再送」。
  - `scrubSecret` 照樣過一遍：檔案裡要是貼了 Key，也不能進上下文。
- **讀的工具「讀取聊天裝扮」**（自動跑）：給角色名、群名或「全局」，回這些：
  - 用哪個模板，或是自訂。
  - 氣泡主題名。
  - 佈局各數值，標出哪些是角色覆蓋。
  - 有沒有背景圖、提示音是什麼。
  - CSS 有幾行。
  - 也能列出所有模板和誰在用。
- **改的工具「改裝扮」**（只出提案）：
  - 能做的事：換模板、改佈局數值、換氣泡主題、改模板內容。
  - CSS 照舊走「寫CSS」。
  - 套用前快照、可還原，和其他提案一樣。

## 8. 分批

| 批 | 內容 |
|---|---|
| 1 ✅ | Sore 收文字檔＋「讀取聊天裝扮」（不等 App，同事馬上能用） |
| 2 ✅ | 裝扮 App 本體：首頁、模板資料與搬遷、編輯頁（預覽、五分頁、全螢幕 CSS）、氣泡工坊嵌進來、桌面圖示改名；寫穿與指定 |
| 3 ✅ | 聊天裡的快捷入口改版、群聊接上 |
| 4 ✅ | Sore「改裝扮」提案＋知識更新 |

桌面圖示沿用 `AppID.ThemeMaker`，只改名字和圖示，因為用戶的桌面版面存的是 App id，換 id 會讓圖示從桌面消失。

## 9. 定案（Liora，2026-11-15）

1. **綁定**，模板要能原地「複製一份」：常見情況是不同聊天只差一張底圖，複製一份改底圖就好。
2. 聊天裡的入口**主要選模板**，給一個按鈕連到裝扮 App（第 6 節）。
3. **群聊一起進模板**，只套群吃得到的（第 5 節）。
4. Sore **也能出提案改**裝扮，放最後一批（第 7 節）。

## 10. 實況

### 第 1 批（2026-11-15）

- 附件：`utils/assistant/attachments.ts`。附件鈕（迴紋針）`accept` 是圖片加 `.css／.txt／.json`，一次最多 3 個檔、3 張圖。
  - 檔案讀成字串存在 `AssistantMessage.files`。
  - Key 用 `scrubKeys` 換掉（全域、副 API、API 庫的那幾把，加上 sk-／ak-／key- 開頭的長串）；`scrubSecret` 改成 `scrubKeys` 再截 400 字。
  - 單檔 60k 字，超過就截斷並標記。
  - `toModelMessages` 只送最近 2 則帶檔訊息的全文，更早的換成一句。
  - 埋點「向Sore提问」多了 `附档`。
- 讀取聊天裝扮：`utils/assistant/decorationRead.ts`。
  - 合併規則照畫面（`resolveDecorationTheme`＋`mergeChatFineTune`）。
  - 角色的佈局標出哪幾項是自己的（`chatAppearance` 有的，加上 `chatFineTune` 開著時定義了的）。
  - 群只講群有的三樣。
  - 不給 target＝全局＋哪些角色有自己的裝扮。
- Sore 的知識和規矩補上：
  - 現在裝扮在「＋→聊天裝扮」。
  - 附件怎麼看（別處的 CSS 要對選擇器改寫）。
  - 佈局、氣泡、背景、提示音只能讀不能改。

### 第 2 批（2026-11-15）

- **純邏輯**在 `utils/decorationTemplates.ts`：
  - 寫穿的 patch：`characterPatchFromDraft`／`themePatchFromDraft`／`groupPatchFromDraft`。都會先清回「跟著全局」再寫模板有的項目；全局沒填的項目回系統默認。
  - 抽出現在的樣子：`templateFrom*`。抽出來再寫回去，畫面一樣（有測試鎖著）。
  - 狀態：模板／自訂／跟著全局。
  - 誰在用：小號不算。
  - 複製一份、舊預設轉模板。內嵌的氣泡跟已有的一模一樣（不看欄位順序）就沿用。
  - 匯出成 `sullyos-chat-decoration` v1。
- **解除綁定**：`detachCharacterPatch`／`detachThemePatch`／`detachGroupPatch` 接在 OSContext 的 `updateCharacter`、`updateLine`（非主線先換成線的視角再判斷）、`updateTheme`、`updateGroup`。
  - patch 動到裝扮欄位、值真的變了、又沒帶 `decorationTemplateId`，就清掉綁定，變自訂。
  - 舊的半窗面板、Sore 套 CSS、聊天裡換氣泡都自動算數。
- **欄位**：`decorationTemplateId` 加在 `OSTheme`、`CharacterProfile`（也進 `LINE_SETTING_FIELDS`，跟著線走）、`GroupProfile`。角色卡分享時剝掉。
- **儲存**：`utils/decorationTemplateStore.ts`，assets 表 `decoration_templates_v1` 一列 JSON。
  - 第一次打開就把 `chat_decoration_presets_v1` 搬過來，舊的那列不刪。
  - 完整和媒體備份會帶上；只備份文字那種不帶，跟其他 assets 一樣。
- **預覽**：`components/decoration/DecorationPreview.tsx`。
  - 用 `ChatHeaderShell`、`MessageItem`、`ChatInputArea` 配假訊息。
  - 根容器的底色、底紋跟聊天共用 `utils/chatRootLook.ts`（Chat.tsx 改用它）。
  - 外層 `transform` 把 fixed 關在框裡，整塊 `inert`。
- **App**：`apps/DecorationApp.tsx`。
  - 桌面圖示沿用 `AppID.ThemeMaker`，名字改「裝扮」，PhoneShell 和 preload 改指到這裡。
  - 首頁三段。「正在用」點一行可以：換模板、跟著全局、編輯現在的樣子／只改這個聊天、存成模板。
  - 模板卡片：指定給…、編輯、複製一份、匯出、刪除。刪掉時用它的聊天留著現在的樣子，變自訂。
  - 指定：取消勾的留著樣子變自訂，勾上的自訂聊天會提醒被換掉。
  - 匯入：裝扮檔、CSS／TXT、圖片當背景。
- **編輯頁**：`components/decoration/DecorationEditor.tsx`。
  - 草稿制，按「存」才寫，沒存要離開會問。
  - 預覽可以收起來。
  - 除了全局，每一項都有「跟著全局」開關。
  - CSS 可以選疊在全局上；群一律疊。
  - 群只有氣泡、聲音、CSS 三頁。
- **氣泡**：`ThemeMaker` 多了 `embedded`。返回、存完回裝扮 App，存完自動選上那套，不跳「套用給角色」。
- **全螢幕編輯框**（`ExpandableTextarea`）高度跟著 `visualViewport` 走，鍵盤彈起來游標那行不會被蓋住。所有用它的地方都受惠。
- 聊天裡「氣泡」分頁的連結改成打開裝扮 App，並帶上這個角色（`utils/decorationHandoff.ts`），返回回到聊天。

### 第 3 批（2026-11-15）

- **快捷面板** `components/decoration/DecorationQuickPanel.tsx`：私聊「＋」→「聊天裝扮」打開的就是它，舊的半窗編輯面板（`ChatDecorationPanel`）不再從聊天打開。
  - 檔案留著給測試夾具用。
  - 面板上的東西：「現在用什麼」、跟著全局（非主線是「跟著主線」）、模板清單、「到裝扮 App 編輯」。點模板就換上。
  - 沒有任何輸入框，鍵盤不會跳出來。
  - 自訂的聊天換模板前會先問：「先存成模板再換」、「直接換」或取消。另外隨時可以「把現在的樣子存成模板」。
  - 「看效果」收起面板。
- **群聊**：「＋」裡的「白框」改成「裝扮」，打開同一個面板。
  - 群只套 CSS、聲音、我的氣泡，用不到的項目會寫出來。
  - 底下留「直接改這個群的白框 CSS」，打開原本的白框 sheet。
  - 從群進裝扮 App，返回時用 `onReturn` 回到同一個群（`openGroupChat`）。
- **非主線**：Chat 給的是線視圖，`updateCharacter` 照線走，所以面板改的是那條線。
  - 「跟著主線」＝把那條線的裝扮欄位全清掉，沒設的照主線。
  - 模板沒填的項目，在非主線上也是跟著主線。這是線的規則（`utils/chatLine.ts`），裝扮不另外處理。
- **寫穿對象** `templateBindings`：比 `templateUsage` 多了小號和非主線（`lines[身份鍵].decorationTemplateId`）。
  - 改模板、刪模板都照它；非主線用 `linePatchForChar` 寫。
  - 首頁卡片「N 個聊天在用」也照它算；「指定給…」清單照舊只列主線、非小號。

### 第 4 批（2026-11-15）

- **邏輯**在 `utils/assistant/decorationOps.ts`，工具接在 `utils/assistant/tools.ts`。
- **讀的工具「讀取裝扮模板」**：不給參數就列出全部模板，寫出誰在用；給 template 回那一份的全部內容，包括每一項佈局和 CSS 全文。
- **寫的工具「改裝扮」**：template 和 target 只能給一個，出一張提案卡片。
  - 給 template 是改模板；加 `create: true` 是新建，`from` 可以拿某個聊天現在的樣子當起點。
  - 給 target 是改某個聊天，可以是角色名、群名或「全局」。
  - ops 有這些：`layout`、`layout_follow`、`bubble`、`bubble_follow`、`background`（只改底紋；Sore 給不了圖）、`background_no_image`、`background_follow`、`sound`（只收內建音效或 none）、`sound_follow`、`css`、`css_stack`、`css_follow`、`rename`。
  - 只能用在模板上的：`css`、`css_follow`、`rename`。某個聊天的 CSS 照舊用「寫CSS」。
  - 只能用在聊天上的：`use_template`、`follow`，而且要單獨一張卡片。
  - CSS 用 `chat_chrome_char` 的規則檢查。
  - 群改佈局或背景會直接擋下。全局不能「跟著全局」。
- **卡片內容**：
  - 改模板時寫出誰在用，提醒套用後這些聊天會一起變。
  - 直接改一個綁著模板的聊天時，卡片會寫「會從模板變成自訂」。
- **套用與還原**：
  - 改模板：存模板，再用 `templateBindings` 寫穿到所有綁著它的聊天。快照存的是改之前的模板，還原時寫回去再寫穿一次。
  - 新建模板：還原就把它拿掉；之後才綁上它的聊天，會留著現在的樣子變成自訂。
  - 改某個聊天：快照存原本的 templateId 和 `templateFrom*` 抽出的草稿。還原時，原本綁著的模板還在就寫回模板，不在了就照草稿寫回。
- **預覽**：卡片上的「預覽」借用裝扮 App 的 `DecorationPreview`，可以切換「套用後／原本的」看。
- **捷徑**：裝扮 App 的模板編輯頁，CSS 分頁有「請 Sore 幫忙」（handoff 的 location 是 `'decoration'`），每輪會告訴 Sore 要改哪份模板。
- **Sore 的規矩**：用戶說「改某某的聊天」時，Sore 要問清楚是改模板，還是只改這一個聊天（會變成自訂）。兩個聊天只差一點點的話，建議新建一份模板。
- **埋點**：「处理Sore的提案」和「从捷径找Sore」的 `位置` 多了「装扮」。

### 試用後的調整（2026-11-15）

- **「正在用」可以收起**：超過 5 個聊天時預設收起，只留「全局默認」一行和「還有 N 個角色、N 個群…」。標題右邊的箭頭可以展開或收起。
- **編輯頁的「請 Sore 幫忙」**：模板、全局、角色、群的編輯頁都有，頂欄放一顆「Sore」，分頁上方也有一條提示。
  - 點了會先把畫面上的改動存起來；新模板會直接建好。
  - handoff 的 location 是 `'decoration'`，targetId 用 `template:<id>` 或 `target:<角色/群 id 或 全局>` 區分；Sore 每輪的提示照這個帶。
  - CSS 編輯器自己那顆捷徑在裝扮 App 裡拿掉了，因為它不會先存，跳過去會丟掉草稿。
- **氣泡編輯（`ThemeMaker`）不再用浮在預覽上的半屏面板**：
  - 版面改成預覽在上（40vh）、編輯在下，兩塊不互相蓋住。
  - 「收起預覽」可以讓編輯區佔滿畫面。
  - 原本可以拖動的設置圓鈕拿掉了。
- **氣泡的自訂 CSS 框改用 `ExpandableTextarea`**：至少 40vh 高，右上角 ⤢ 可以全螢幕編輯，全螢幕時的高度跟著鍵盤上方的可見區走。
  - 「限定作用域插入器」照舊插在游標位置，靠 `ExpandableTextarea` 新加的 `inlineRef` 拿到小框的游標。

### 第二輪試用調整：取名與全螢幕（2026-11-15）

試用的人卡在兩件事：頂欄那個小箭頭沒人發現是「放大編輯區」；存新模板時沒地方取名，清單一排「我的裝扮」分不出來，大家跑去 CSS 頁的「我的預設」改名，但那只是另存一份 CSS，回清單名字當然沒變。

- **全螢幕鈕搬到分頁列最右邊**：跟「佈局／氣泡／背景／聲音／CSS」同一排，寫「全螢幕」（收起預覽後變「看預覽」）。頂欄的小箭頭拿掉。氣泡編輯（`ThemeMaker`）那顆也改成同樣的字。
- **新模板一定會問名字**：
  - 頂欄的名字框改成虛線框＋鉛筆，空著時寫「幫這套取個名字」。
  - 新模板按「存」或「Sore」時，名字還空著就跳底部小視窗「幫這套裝扮取個名字」（`data-decoration-naming`），填了才存；「先不要」就不存。
  - 沒填名字也能存的入口（從某個聊天「存成模板」等）照舊自動取名。
  - 自動取的名字一律過 `uniqueTemplateName`（`utils/decorationTemplates.ts`）：撞名就在後面接「 2」「 3」，清單不會出現兩個一樣的名字。手動改名不擋重複，使用者自己決定。
- **模板卡片能直接改名**：名字旁邊有「改名」，點了跳小視窗（`data-decoration-rename`）。卡片多一行「改於 …」，同名或相似的也分得出新舊。
- **裝扮 App 裡的 CSS 編輯器不顯示「我的預設」**：`ChromeCssEditor` 加 `hideMyPresets`。那一塊存的是「一段 CSS」，在裝扮 App 裡跟「模板」重疊，留著只會讓人以為是在存整套。聊天設定裡原本的 CSS 編輯器照舊有。
- 剛存完新模板會跳「指定給誰」，什麼都不選直接按「好了」不再跳「沒有變化」，免得以為沒存到。
