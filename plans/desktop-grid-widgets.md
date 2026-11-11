# 桌面網格與小組件

> 狀態：三批都做完（2026-11-10）。第 1 批：統一網格、自由拖放與跨頁、加頁刪頁、內建小組件可增刪換尺寸、圖片小組件不再有白框。第 2 批：自訂小組件（HTML／CSS／圖片／欄位／綁角色）、沙盒 iframe、匯入匯出 `.widget.json`。第 3 批：`widget.setState`、日期欄位、七個內建範本。
> 提議來自 Liora（2026-11-10）：桌面 app 位置太死（第 1、2 頁寫死，第 3 頁以後只有兩排），小組件只有外觀訂製裡三個圖片位，去背 PNG 還有白框。

## 已定案

- **整個預設桌面改成一套網格**：每頁 4 欄 × 6 列，app 佔 1 格，小組件佔 寬×高 格。**寬在前**：1×2 是直的長條，2×1 是橫的
- **Android 式**：放哪就在哪，中間可以空著，不自動往前補
- 搬動規則：拖到空格就放；正好蓋住一個一樣大、左上角也對齊的就交換；其他蓋到東西的，放下去、蓋到的往下擠（2026-11-10 Liora 回饋後改，原本是彈回原位）。只有出界才放不下
- 現有的時鐘＋角色卡、日程、正在播放、圖片、月曆、紀念日都變成內建小組件
- 舊用戶第一次打開：照原本寫死的那幾頁排出來（同樣的東西、同樣的順序），不會一打開就亂
- 只改預設桌面（含紙感、動森兩種皮膚，它們本來就用同一個 Launcher）；手遊風、小小窩、觸感陪伴有自己的版面，不動
- 自訂小組件（第 2 批）：允許少量互動和 JS，關在沙盒 iframe；可以綁一個角色；欄位放上桌面後每一份分開填；要能匯入匯出，相容 Liora 給的 `custom_widget_template` 格式（見下）

## 資料結構（第 1 批）

存在 `OSTheme.launcherLayout`（`utils/launcherLayout.ts` 的 `LauncherLayout`），跟著主題走：localStorage `os_theme`（圖片清理整行掃得到令牌）、外觀預設、完整備份。

```ts
interface LauncherLayout { version: 1; pages: LauncherPage[] }
interface LauncherPage { id: string; items: LauncherItem[]; decorations?: boolean }
type LauncherItem =
  | { id; kind: 'app'; appId; x; y }
  | { id; kind: 'widget'; widget: BuiltinWidgetType; x; y; w; h; image?: string; frame?: boolean };
```

- 沒存過 `launcherLayout` 就由 `buildLegacyLayout` 從舊欄位（`launcherAppOrder`、`launcherPinwheelOrder`、`launcherWidgets`）排；**第一次動手整理才存**，之前每次打開都照舊欄位現排
- `normalizeLayout` 每次讀都跟 app 清單對齊：不存在的拿掉、重複的留一個、出界或疊住的重新找位置、新 app 接在最後一頁有空的地方
- Dock（`launcherDockOrder`）：2026-11-11 起能跟網格互換，見下面「Dock」
- 桌面裝飾 DIY 那層跟著舊版第 3 頁（`decorations` 標記）；新排的版面沒有標記就放第 3 頁
- 外觀訂製的「首頁方形圖片」「桌面小組件」兩塊拿掉了，換成一張說明卡：圖片位已經照原位置變成圖片小組件

## 內建小組件與尺寸

| 小組件 | 尺寸（第一個是預設） | 能放幾個 |
|---|---|---|
| 時鐘 | 4×2、4×1（置中，只留一排星期日期和時間，不是等比縮小）、2×1（靠左、星期縮寫，旁邊兩格能放別的） | 多個 |
| 角色卡 | 4×1、4×2 | 多個 |
| 角色日程 | 4×2、4×3 | 一個 |
| 正在播放 | 2×2 | 一個 |
| 圖片 | 2×2、1×1、1×2、2×1、4×1、4×2、4×3、4×4 | 多個 |
| 月曆 | 4×3、4×4（整個月、格子撐滿；4×4 底下多一行下一個紀念日）、4×1（這一週一條）、2×2（今天） | 一個 |
| 紀念日 | 4×3、4×2、4×4（一頁幾則照高度） | 一個 |

有自然高度的（時鐘、日程、月曆）放在 `FitBox` 裡，格子比內容小就等比縮小；音樂放 `SquareBox` 取正方形。
圖片小組件**預設不加外框和陰影**，去背 PNG 直接透出（以前寫死一圈半透明白邊，就是那條白線）；開了「外框與陰影」才裁成圓角卡片。舊的三個圖片位轉過來時保留原本的外框。

## 整理模式

長按 app 或小組件 520ms 進入（圖示輕微抖動）。上方一條：「拖到哪放哪，蓋到的會往下擠」＋「＋小組件」「＋頁面」「完成」。
- **整理中照樣能左右滑頁**：捲動容器是 `touch-action: pan-x`，app／小組件也是 `pan-x`。按下去馬上滑就是翻頁（按在 app 上也行）；手指按住不動 180ms 才抓起來，抓起來之後由一個非 passive 的 `touchmove` 監聽擋掉捲動（React 的 onTouchMove 是 passive 的，擋不了）。很快點一下（還沒抓起來就放開）照樣打開小組件設定。滑鼠不會捲頁，按下去直接抓
- 拖動時目標格顯示虛線框：空的是白的、會把東西往下擠是黃的、出界是紅的；拖到左右邊緣會翻頁
- **往下擠**（`launcherLayout.ts` 的 `pushDown`）：放好的東西先定位，這頁其他東西由上往下一個個看，跟已定位的重疊就往下挪一列直到不重疊（會連鎖）。擠出最後一列的，先在這頁找空位（所以可能跑到上面的空格），這頁沒空位就往後面的頁放，再沒有就加一頁；搬到別頁的會跳 toast 說幾個
- 小組件左上角「−」直接移除；點一下打開設定：換尺寸（原位放不下就在同頁找空位，同頁都沒有就不換）、圖片小組件換圖和開關外框、移除
- 空白頁中間有「刪除這一頁」；只有空頁能刪、至少留一頁
- 「＋小組件」放到目前這一頁，放不下往後找，都不行就加一頁；只能放一個的已經在桌面上就灰掉

## 第 2 批：自訂小組件

純邏輯在 `utils/customWidget.ts`（匯入匯出、佔位符、組 srcdoc），畫面 `components/launcher/CustomWidgetFrame.tsx`，
編輯器 `CustomWidgetEditor.tsx`，這一份的設定 `CustomWidgetSettings.tsx`。

**模板和每一份分開存**
- 模板：`OSTheme.launcherCustomWidgets`（名字、HTML、CSS、預設尺寸、`imageKeys`＋模板自帶的圖、欄位定義）。圖片是 blobref 令牌，跟著主題走所以完整備份、圖片清理都掃得到
- 放上桌面的每一份：`launcherLayout` 裡 `widget: 'custom'` 的格子，記 `templateId`、`values`（這一份填的欄位）、`images`（這一份換掉的圖）、`charId`（沒綁就跟著目前角色）
- 改模板，桌面上用它的每一份都跟著變；刪模板會問，用它的那幾份一起拿掉。模板不見了的格子顯示「模板不見了」，點它可以移除
- 尺寸：1×1、1×2、2×1、2×2、4×1、4×2、4×3、4×4，每一份可以自己換

**入口**：整理模式「＋小組件」最下面一塊「自訂小組件」：新建（存好直接放上桌面）、匯入檔案；每個模板有放上桌面、編輯、匯出、刪除。整理中點一下某一份：尺寸、綁定角色、欄位、換圖、編輯模板、移除。

**佔位符**（HTML 和 CSS 都能用，見 `BUILTIN_PLACEHOLDERS`）
- `{{time}}`、`{{date}}`、`{{weekday}}`：用戶設備的時間（跟桌面的鐘一樣，不跟角色時區）。寫在 HTML 文字裡的會換成 `<span data-soren-live>`，自己每 10 秒走一次；屬性、`<script>`、`<style>` 裡的是組出來那一刻的值
- `{{user}}`；`{{char}}`、`{{char.avatar}}`、`{{char.lastMessage}}`、`{{char.unread}}`、`{{char.mood}}`（情緒取 `activeBuffs[0]` 的 emoji＋名字）
- 欄位 `{{鍵}}`（這一份填的 → 模板預設 → 空）；圖片 `{{鍵}}` 或 `{{img:鍵}}`，還沒選圖給 1×1 透明圖，不出破圖示
- 不認得的 `{{…}}` 原樣留著。值依位置跳脫：文字和屬性做 HTML 跳脫、`<script>` 裡做 JS 字串跳脫、CSS 只擋 `</style>`
- 內建的鍵（還有 `char.*`、`img:*`）不能拿來當欄位或圖片的鍵

**沙盒**
- `sandbox="allow-scripts"`，不給 same-origin、top-navigation、popups：讀不到 Soren 的資料、跳不走頁面。localStorage 用 `utils/sandboxShims.ts` 的記憶體替身（見面裝飾卡片也搬過來共用）
- 沙盒讀不到 Soren 的 blob，圖片（模板的、這一份的、角色頭像）先轉成 data URL 再填進去；編輯器和設定頁上傳的圖壓到 1000px 寬
- iframe 裡先跑的腳本提供 `widget`：`getState(key)`（async，跟匯入格式一樣，沒值回 `null`）、`setState(key, value)`（第 3 批）、`getAll()`、`open(target)`、`size`（只有 `{ w, h }`）
- **iframe 不吃指標事件**：桌面照常滑頁、長按整理、拖動。不在整理中時上面蓋一層透明的，點一下把座標 postMessage 進去，裡面 `elementFromPoint` 派一個 click，碰到 `data-open` 就回報。所以只有「點一下」：小組件裡的拖曳、捲動、輸入框不會動
- `data-open="chat"` 或 `widget.open('chat')` 打開綁定角色的聊天；填 App 代號（`constants.tsx` 的 id）就開那個 App，其他值不理。只認點完 1.5 秒內的，程式不能一載入就把人帶走
- 連結點了不跳（攔掉 `a[href]` 的 click）。遠端圖片、字型還是載得到，跟見面的裝飾卡片一樣
- **毛玻璃**：iframe 裡的 `backdrop-filter` 模糊不到外面的桌布。尾段腳本看最外層元素：有 `backdrop-filter` 而且幾乎蓋滿小組件，就把濾鏡和圓角回報出來，外層那個 div 代為套上（只收 `blur()` 這類寫法的字串）。範例的「frosted」靠這個才有效果

**匯入匯出**
- 匯入：`parseWidgetFile`，壞檔給中文原因；重複或不能用的鍵略過、沒選項的 select 變一行字、認不得的尺寸用 4×2，略過的東西在 toast 裡說。檔案裡沒帶圖的話提醒要自己選
- 匯出：`buildWidgetFile`，`type: custom_widget_template`、`version: 2`；尺寸剛好是 2×2／4×2／4×4 寫 small／medium／large，其他寫 `"1x2"`。模板自帶的圖轉成 data URL 放在 `images`（鍵 → data URL，範例格式沒有這欄，別的 app 不認也不影響）；每一份自己換的圖不帶
- 欄位多帶一個 `default`（範例格式沒有，讀的時候也收 `defaultValue`）

## 第 3 批：小組件自己存東西＋內建範本

**`widget.setState(key, value)`**
- 存在這一份格子的 `state`（`launcherLayout` 裡，跟 `values` 分開：`values` 是用戶在設定裡填的，`state` 是小組件自己點出來的）。`getState` 先看 `state` 再看欄位和佔位符
- 值一律存成字串（不是字串的先 `JSON.stringify`），`null` 是刪掉。上限 `WIDGET_STATE_LIMITS`：30 個鍵、一個值 5000 字、全部 2 萬字，超過的那筆不存（`applyWidgetState`）
- **只認點完 5 秒內的**：不然一個每秒存一次的小組件會一直寫主題。iframe 裡先記著，外面停 0.6 秒才一起存回去；存的東西不在 srcdoc 的依賴裡，存一次不會重載 iframe
- 設定裡有「小組件記住的東西 → 清除」，清掉會重載那一份
- 匯出不帶 `state`，備份會帶（跟著 `launcherLayout`）

**日期欄位**：`type: 'date'`，值是 `YYYY-MM-DD`，設定裡是原生日期選擇器。

**內建範本**（`utils/widgetStarters.ts`）：「＋小組件」最上面一塊「不知道放什麼？從範本開始」，每個有即時預覽。「用這個」把一份放上桌面，**直接指著範本**（`templateId: 'starter:<id>'`，從 `STARTER_TEMPLATES` 現拿），不複製進「我的小組件」，從桌面移除就什麼都不留；要先填才好看的（在一起的天數、拍立得）順手打開這一份的設定。
- 範本不能直接改：桌面上那一份點「編輯模板」會複製一份成自己的模板（新 id），存好那一份改指新模板（`retargetItemId`）
- 2026-11-10 第一版的「用這個」是複製進「我的小組件」，越放越長。`findUntouchedStarterCopies` 認出還沒改過（內容跟範本一樣、沒放自己的圖）的複製品，Launcher 打開時把桌面上的改指範本、複製品拿掉，只做這一次；改過的是用戶自己的東西，不動

| 範本 | 尺寸 | 用到的東西 |
|---|---|---|
| 倒數日 | 2×2 | 日期欄位、getState |
| 在一起的天數 | 4×1 | `{{char.avatar}}`、日期欄位、`data-open="chat"` |
| 角色近況 | 4×2 | `{{char}}`、`{{char.mood}}`、`{{char.lastMessage}}`、`{{char.unread}}`、`data-open` |
| 拍立得 | 2×2 | 三個圖片鍵、點一下換下一張（setState 記第幾張） |
| 今日待辦 | 2×2 | 多行字欄位、點一下打勾（setState，可每天重來） |
| 喝水計數 | 2×2 | 數字欄位、點一下加一、右上「−」減一（setState，每天歸零） |
| 便條紙 | 2×2 | 多行字、選項欄位放在屬性裡配 CSS 選擇器，沒有程式 |
| 打字機（第 4 輪） | 4×1 | 多行字輪流打、顏色欄位留空就跟字一樣 |

寫範本要注意：字級用 `vmin`（4×1 這種扁的用 `vh`），換尺寸才會跟著縮放；最外層蓋滿整格，毛玻璃才會交給外層代套；**程式裡別直接寫 `{{…}}`**，會先被填成值（「在一起的天數」把 `{{char}}` 拆開寫就是這個原因）。範本的欄位鍵不能撞內建佔位符（`date` 就撞了，倒數日用 `day`），測試會擋。

## 實機回饋修正（2026-11-11）

- **iOS 長按圖片跳出「儲存到照片」選單、放開後整個桌面點不動；圖片小組件有時拖不動**：圖片吃了長按（系統選單、原生拖曳），桌面收不到。桌面格子裡的 `img` 一律 `pointer-events: none`、`-webkit-user-drag: none`、`-webkit-touch-callout: none`，根節點也 `-webkit-touch-callout: none`。另外每次按下先收掉上一次沒收乾淨的拖動（影子、半透明），手指按下也清掉滑鼠拖頁的殘留位移（iOS 補發的相容滑鼠事件偶爾只有 mousedown，留著的位移會把之後的點擊全擋掉）
- **從小組件或聊天列表進聊天，按返回出現 about:srcdoc、再退出黑屏**：已經載入過的 iframe 改 `srcdoc` 是一次導覽，會塞一筆瀏覽器歷史（Chromium 實測改兩次 history.length 2 → 4）。小組件剛出現時頭像、最後一則訊息陸續讀到，內容會換好幾次，編輯器預覽每停一下也換一次；外殼的返回守衛（`PhoneShell`）按返回時跳進 iframe 的歷史。現在內容一變就換一個新的 iframe（`utils/sandboxShims.ts` 的 `nextSandboxFrameKey` 當 React key），新插的 iframe 第一次載入不進歷史。見面裝飾卡片、聊天 HTML 卡片同樣處理
- **編輯器點欄位打字，鍵盤一出來只剩一條細縫；收起後整頁往上跑、「儲存」看不到、退不出去**：預覽固定高度佔掉大半；而且 iOS 把輸入框捲進畫面時連 `overflow: hidden` 的外層也捲了，鍵盤收起不會捲回來。編輯器改成頂上那條固定、下面整塊一起捲（分頁黏在頂上）；`components/launcher/useResetHiddenScroll.ts` 在輸入框失焦後把往上每一層 `overflow: hidden` 卻被捲過的拉回 0（設定面板也用）

## 第 4 輪：範本換背景、依尺寸換版型、打字機、更多匯入寫法（2026-11-11）

- **模板可以限定尺寸**：`CustomWidgetTemplate.sizes`（沒有就是 8 種全部），放上桌面後設定裡只列這幾種（`templateSizes`）。匯出時是 `sizes: ["4x1", "small"]`，匯入也收
- **範本依尺寸換版型**：iframe 裡的 media query 量的是這一格自己，用寬高比分三種——扁長 4×1（`min-aspect-ratio: 5/2`）、橫的 2×1／4×2（3/2～5/2）、方的 2×2／4×3／4×4。扁的字級用 `vh`、方的用 `vmin`，同一種版型換大小也跟著縮放
- **背景**：有卡片底的範本（倒數日、在一起的天數、角色近況、今日待辦、喝水計數、打字機）共用一個欄位 `bg`：淺色毛玻璃／深色毛玻璃／透明／底圖，還有一個圖片鍵 `底圖`（中文鍵，設定裡一看就懂）。卡片外層寫 `data-bg="{{bg}}"`，CSS 依它換底、字色 `--ink`、小底塊 `--surface`；透明的字色跟桌面字色走（`buildWidgetSrcDoc` 放了 `--soren-content-color`）。拍立得、便條紙本身就是一個物件，沒有這個欄位
- **打字機**範本（4×1、2×1、4×2，預設透明）：一行一句輪流打，速度、斜線／字／底線顏色可調；顏色欄位留空時那條 CSS 宣告是空的、會被略過，就跟字一樣
- **相容另一種匯出寫法**（Liora 給的 ScrollingText）：`size: "size_4x1"`、`widget.onReady(cb)`、`widget.getAllState()`
- **編輯器「加一張」**：鍵名可以留空，自動取 img1、img2…，加好直接打開選圖（以前空白按下去只跳「這個鍵不能用」）
- 範本改了內容，`findUntouchedStarterCopies` 對不上舊版複製品：舊版（#141）每個範本的內容指紋記在 `LEGACY_STARTER_FINGERPRINTS`，照樣認得出來

## Dock（2026-11-11）

**跟網格互換**（`launcherLayout.ts` 的 `normalizeDockOrder`／`moveAppToDock`／`moveDockAppToGrid`）
- Dock 最多 `DOCK_MAX` = 5 個。沒存過照預設那四個（`DOCK_APPS`）；存過照存的，**搬走的不會自動補回來**（以前會從 `DOCK_APPS` 補齊）。網格上的 app＝全部扣掉 Dock 裡的
- 網格的 app 拖到 Dock 上某一個：交換，那一個搬到這個 app 原本的格子；拖到 Dock 的空處：接在最後（滿了不行）。小組件放不進 Dock
- Dock 的 app 拖到網格：空格就放；正好蓋住一個 app 就交換（那個 app 進 Dock 原本的位置）；蓋到小組件就放下去、往下擠
- Dock 和版面一次寫回去（`commitLayout(layout, { launcherDockOrder })`，分兩次寫後一次會蓋掉前一次）。拖 Dock 的 app 到左右邊緣也會翻頁
- Dock 空了平常不畫，整理中留一塊「把 app 拖到這裡」
- 順手修：訊息未讀紅點以前只認舊的 `chat` 代號，Dock 換成 Message（`chat_hub`）後就沒出現過；現在 Message 在 Dock 或網格上都掛

**樣式**（外觀 → Dock，`utils/dockStyle.ts`，存 `OSTheme.dockStyle`／`dockCustom`）
- Liquid Glass（預設，沒設也是）：原本那條；紙感桌布、動森皮膚照舊用各自的版本
- 無膠囊：只有圖示
- 自訂：底色＋不透明度、背景模糊、圓角、邊框顏色和粗細、陰影、底圖（blobref 令牌，有圖時底色疊在圖上）。外觀頁的滑桿停 0.35 秒才寫回主題
- 桌面和外觀頁預覽都用 `dockContainerLook` 畫，看到的一樣

### 還沒做的

- 欄位類型：開關、檔案
- 範本只有七個；之後想加，照上面的注意事項寫進 `WIDGET_STARTERS`，`widgetStarters.test.ts` 會檢查鍵、尺寸、選項

### 要相容的匯入格式（Liora 給的範例）

```json
{
  "type": "custom_widget_template", "version": 2, "name": "…", "size": "medium",
  "html": "…<img src=\"{{img1}}\">…<script>… await widget.getState('text1') …</script>",
  "css": "…",
  "imageKeys": ["img1", "img2", "img3"],
  "userFields": [{ "key": "bgStyle", "label": "背景样式", "type": "select", "options": ["frosted", "transparent"] },
                 { "key": "timeColor", "label": "时间颜色", "type": "color" },
                 { "key": "text1", "label": "文案", "type": "text" }]
}
```

- `size`：small → 2×2、medium → 4×2、large → 4×4；也收 `"4x2"` 這種直接寫格數的
- 程式靠 `widget.getState(key)` 讀欄位：沙盒裡要提供同名、回 Promise 的介面
- 檔案裡有零寬字元（註解、選項值裡，可能是作者浮水印）：原樣保留，不清
- 匯入的內容不轉繁體（跟匯入的見面預設一樣）
