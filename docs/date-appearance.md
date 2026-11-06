# 見面 · 畫面美化

見面設定 →「畫面美化」。設定存在角色的 `dateAppearance`（`types.ts` 的 `DateAppearance`），跟著角色走；沒設的項目一律照原本的樣子，舊用戶打開不會變。

邏輯都在 `utils/dateAppearance.ts`，介面是 `components/date/DateAppearanceSettings.tsx`，套用在 `components/date/DateSession.tsx`。

## 各項怎麼生效

| 項目 | 欄位 | 怎麼套 |
|------|------|--------|
| 底圖 | `dateBackground`（原有，blobref 令牌） | 照舊 |
| 遮罩濃度 | `backgroundDim` 0–100 | 沒設：原本的樣子（底圖 30% 糊在後面，閱讀區蓋深色 80%／淺色 90%）。設了：底圖 100% 顯示，閱讀區蓋一層這個濃度的遮罩（深色黑、淺色米白） |
| 底圖模糊 | `backgroundBlur` | 只在設了遮罩後才出現，預設模糊 |
| 字級 | `fontSize` 14–24 | 角色正文 `.date-line` 用這個字級，你說的話 `.date-line-user` 小兩級；預設 18 不存 |
| 字色 | `colors.light` / `colors.dark`，各有 `dialogue`、`narration` | 深淺兩套各記各的，設定頁改的是目前這套。只收 `#rgb`／`#rrggbb` |
| 裝飾卡片墊深色底 | `decorationDarkCard` | 只在淺色模式生效：裝飾 iframe 外面包一塊深色圓角底，iframe 裡也照深色模式的預設字色 |
| 自訂 CSS | `customCss` | 過 `scopeDateCss` 後注入，見下 |

字級、字色產生的 CSS 掛在 `.date-root` 底下（兩個 class 的權重），蓋得過 Tailwind 的單一 class；用戶自訂 CSS 排在它後面，同權重時用戶的贏。

## 自訂 CSS 的範圍

- `.date-root` 只包見面畫面本身（底圖、選單鍵、閱讀區、輸入框）。見面設定、換模型面板、彈窗都放在 `.date-root` 外面，用戶寫壞了也還能回設定頁改回來。
- `scopeDateCss` 把每條選擇器都加上 `.date-root`：`p{}` → `.date-root p{}`；`:root`／`html`／`body` 開頭的換成 `.date-root` 本身；已經寫了 `.date-root` 的不動。`@media`／`@supports`／`@container`／`@layer` 往裡限定，`@keyframes`／`@font-face` 原樣。註解先拿掉。
- 上限 5 萬字。
- 裝飾 iframe 是獨立文件，自訂 CSS 管不到裡面（只能管外框 `.date-decoration-card`）。

## 可用的 class

清單在 `DATE_CSS_HOOKS`，設定頁「可用 class」顯示的就是它，要加鉤子兩邊一起改：

| class | 是什麼 |
|-------|--------|
| `.date-root` | 整個見面畫面；同時帶 `.date-theme-light` 或 `.date-theme-dark` |
| `.date-background` | 底圖 |
| `.date-reading` | 閱讀區（可捲動那塊，遮罩也在這） |
| `.date-opening` | 還沒開始對話時顯示的開場 |
| `.date-message`（＋`-ai`／`-user`） | 一則訊息 |
| `.date-line` | 角色正文的每一行；台詞再帶 `.date-line-dialogue`，旁白帶 `.date-line-narration` |
| `.date-line-user` / `.date-line-name` | 你說的話／後面那個名字 |
| `.date-decoration-card` | 裝飾卡片外框 |
| `.date-input-bar` / `.date-input` | 輸入框外殼／輸入框 |

原本的底色、遮罩是 Tailwind class 或 inline style，要蓋得加 `!important`。

## 預覽

設定頁上方的小預覽用同一套 class，草稿裡還沒存的 CSS 也套上。設定頁的樣式不在 `.date-root` 裡，不受影響。
