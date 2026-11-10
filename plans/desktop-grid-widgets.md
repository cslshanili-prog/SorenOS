# 桌面網格與小組件

> 狀態：第 1 批做完（2026-11-10）：統一網格、自由拖放與跨頁、加頁刪頁、內建小組件可增刪換尺寸、圖片小組件不再有白框。第 2 批（自訂小組件、匯入匯出）未開始。
> 提議來自 Liora（2026-11-10）：桌面 app 位置太死（第 1、2 頁寫死，第 3 頁以後只有兩排），小組件只有外觀訂製裡三個圖片位，去背 PNG 還有白框。

## 已定案

- **整個預設桌面改成一套網格**：每頁 4 欄 × 6 列，app 佔 1 格，小組件佔 寬×高 格。**寬在前**：1×2 是直的長條，2×1 是橫的
- **Android 式**：放哪就在哪，中間可以空著，不自動往前補
- 搬動規則：拖到空格就放；正好蓋住一個一樣大、左上角也對齊的就交換；其他放不下的彈回原位
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
- Dock 照舊（`launcherDockOrder`），只在 Dock 裡互換
- 桌面裝飾 DIY 那層跟著舊版第 3 頁（`decorations` 標記）；新排的版面沒有標記就放第 3 頁
- 外觀訂製的「首頁方形圖片」「桌面小組件」兩塊拿掉了，換成一張說明卡：圖片位已經照原位置變成圖片小組件

## 內建小組件與尺寸

| 小組件 | 尺寸（第一個是預設） | 能放幾個 |
|---|---|---|
| 時鐘 | 4×2、4×1 | 多個 |
| 角色卡 | 4×1、4×2 | 多個 |
| 角色日程 | 4×2、4×3 | 一個 |
| 正在播放 | 2×2 | 一個 |
| 圖片 | 2×2、1×1、1×2、2×1、4×1、4×2、4×3、4×4 | 多個 |
| 月曆 | 4×3、4×4 | 一個 |
| 紀念日 | 4×3、4×2、4×4（一頁幾則照高度） | 一個 |

有自然高度的（時鐘、日程、月曆）放在 `FitBox` 裡，格子比內容小就等比縮小；音樂放 `SquareBox` 取正方形。
圖片小組件**預設不加外框和陰影**，去背 PNG 直接透出（以前寫死一圈半透明白邊，就是那條白線）；開了「外框與陰影」才裁成圓角卡片。舊的三個圖片位轉過來時保留原本的外框。

## 整理模式

長按 app 或小組件 520ms 進入（圖示輕微抖動）。上方一條：「拖到空格放下，一樣大的會交換」＋「＋小組件」「＋頁面」「完成」。
- 拖動時目標格顯示虛線框，放得下是白的、放不下是紅的；拖到左右邊緣會翻頁
- 小組件左上角「−」直接移除；點一下打開設定：換尺寸（原位放不下就在同頁找空位，同頁都沒有就不換）、圖片小組件換圖和開關外框、移除
- 空白頁中間有「刪除這一頁」；只有空頁能刪、至少留一頁
- 「＋小組件」放到目前這一頁，放不下往後找，都不行就加一頁；只能放一個的已經在桌面上就灰掉

## 第 2 批：自訂小組件（未做）

- 編輯器：名字、HTML、CSS、圖片素材（上傳後取名，`{{img:名字}}` 或格式裡的 `{{img1}}`）、可填寫欄位（新增鍵；text／color／select，之後可加 number、textarea）、尺寸
- 佔位符：`{{time}}`、`{{date}}`、`{{weekday}}`、`{{user}}`；綁角色後 `{{char}}`、`{{char.avatar}}`、`{{char.lastMessage}}`、`{{char.unread}}`、`{{char.mood}}`；欄位值也能用 `{{鍵}}`
- 沙盒 iframe（`sandbox="allow-scripts"`，不給 same-origin，跟見面的裝飾卡片同一套）；提供 `widget` 物件：`getState(key)`（讀欄位值，async）、少量互動（例如 `data-open="chat"` 打開 App）
- 模板存一份，放上桌面的每一份記自己的欄位值和綁的角色
- 匯入匯出 `.widget.json`；跟著完整備份走

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
