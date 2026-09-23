# ChatApp 裝扮與整套預設

聊天「＋」→「聊天裝扮」統一佈局、氣泡、背景、聲音和進階 CSS（原白框）。舊 `chrome-css`、`fine-tune`、`chrome-sound` action 保持兼容。面板支持角色專屬 / 全局默認、背景透明度和完整聊天預覽。

## 導入 / 分享流程

「進階」旁的「預設」分類統一接受：版本化的整套 JSON、帶 Sully 數據的分享 PNG、CSS/TXT 原文件、原氣泡 JSON、提示音分享碼和普通圖片。分享 PNG 優先解析元數據，角色卡等其他類型明確提示到相應功能導入；損壞文件不降級為普通圖片。

導入只暫存待確認內容，不修改角色。顯示五項內容及應用範圍，可以勾選部分內容；未勾選的部分保持原樣。普通圖片先選聊天背景 / 我的氣泡貼圖 / 角色氣泡貼圖，然後確認。應用過程中禁止切換範圍和離開面板，防止異步應用目標變化。

當前整套裝扮可保存到「我的預設」，或以 JSON / PNG 分享圖導出。本地圖片及 CSS 中的 Blob URL/令牌會內嵌；缺失素材導出報錯，不能把無效令牌分享出去。HTTP(S) 外鏈保持原樣，需要聯網。輸入/輸出均限制 40 MB。預設列表位於資產鍵 `chat_decoration_presets_v1`，隨已有資產備份機制保留。

## 數據邊界

- 格式為 `sullyos-chat-decoration` version 1，`parts` 包含 layout、bubbles、background、sound、css。未知版本拒絕導入。
- 使用聊天視覺字段白名單，只導出當前有效的視覺設置，不包含角色人設、API、聊天內容或整機設置。氣泡以新 ID 安裝，不覆蓋已有同 ID 主題。
- 全局佈局繼續寫 OSTheme；角色整套佈局存 `chatAppearance`（運行時只讀取白名單），原有 `chatFineTune` 為可視化微調層。關閉角色佈局開關會停用佈局覆蓋並保留數據。
- `theme.chatDefaultBubbleStyle` 與 `theme.chatBackground` 為全局默認；角色的 `bubbleStyle`、`chatBackground` 優先。角色背景 undefined 表示繼承，空字符串表示明確無圖片，避免“預設無背景”被接收方舊背景覆蓋。
- 全套導出會將生效的全局 CSS 與角色 CSS 合成。導入到角色後設置 `chatDecorationCssIsolated`，防止接收方全局 CSS 再次混入；普通已有角色仍維持原疊加關係。還原角色 CSS 後恢復全局繼承。
- CSS 與聲音拆分保存。聲音 null 在應用時轉成 `{src:'none'}`（明確靜音），而缺少 sound 是保留原聲音。僅替換 CSS 時先保留當前聲音；手動編輯 CSS 刪除舊 `@sully-sound` 註釋時也轉存到獨立聲音字段。
- 解碼和所有資源準備完成後，先保存新氣泡，再一次更新目標角色/全局設置。保存錯誤會展示，不聲稱成功。舊主題不刪除，避免破壞別的角色。可能尚未引用的新素材交由既有 GC 處理。

## 迴歸入口

- `utils/chatDecoration.test.ts`：白名單、有效快照、文件識別、分享 PNG、缺失素材、選擇性應用、聲音/CSS 保留、全局/角色隔離。
- `scripts/test-chat-decoration-consolidation.mjs`：兩個入口的首次公告、確認後持久化、舊入口移除、搬遷控件與作用範圍。
- `scripts/test-chat-decoration.mjs`：原裝扮控件、聲音綁定、背景、完整預覽與真實 Chat 入口。
- `scripts/test-chat-decoration-presets.mjs`：導入確認、部分應用、取消、普通圖片用途、導出再導入、預設重開、錯誤版本、真實角色落庫與刷新。
- `test/fixtures/chat-decoration.html`：可交互展示；角色修改是頁面臨時狀態，本地預設使用此測試來源的 IndexedDB。

外觀 App 已移除「聊天界面」分類；原佈局控件（含內置佈局、在線狀態、頭像頻率、表情包尺寸、輸入欄）移入裝扮「佈局」，聊天設置的背景上傳也移入「背景」。加號保留一個「聊天裝扮」入口。

外觀 App 和 ChatApp 首次進入各顯示一次本輪公告（無需先找到裝扮入口），點擊「知道了」或 Escape 後，分別存入本地 `sully-chat-decoration-announcement-v1:appearance/chat`。不改動美化數據；存儲不可寫時僅在當前會話記住。

CSS 編輯器的舊預設及分享格式不遷移。CSS 分類保留 body portal 的 `#sully-safe-reset`，標註還原角色或全局；收起面板時也能還原。全局編輯在聊天裝扮中切換「全局默認」；角色切換處的氣泡快捷入口繼續可用。

已確認過舊版 `v1:decoration` 公告的用戶不會重複彈出。裝扮面板本身不再掛公告。聊天加號功能按單一順序列表每頁 8 項自動分頁，第二頁補入相冊；各頁固定兩行，避免第三頁內容少導致面板和翻頁圓點跳動。
