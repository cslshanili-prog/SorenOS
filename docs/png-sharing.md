# PNG 分享卡

在可複用內容的導出入口製作分享圖：上傳預覽圖，填寫作品名稱、作者和使用限制，選擇留白相紙、全幅海報或橫版名片。接收方在對應功能的原有導入入口選擇 PNG 原文件即可還原。原格式導出仍可用。

手機端默認顯示大圖，點擊懸浮的「調整樣式」展開底部小面板。面板分為「圖片與排版」「文字與署名」，只在面板內滾動，預覽始終留在上方實時更新。點擊「收起設置」恢復大圖，填寫內容保留。鍵盤彈出時根據可視區域縮小編輯器並保持當前輸入項可見；Escape 先收起設置，再次按下才關閉編輯器。桌面端保持預覽和設置並排顯示。

| 內容 | 導出 / 導入位置 | 原格式 |
| --- | --- | --- |
| 角色卡 | 角色詳情導出 / 角色列表導入 | JSON |
| 世界書 | 分組導出 / 世界書導入 | JSON |
| 白框 CSS | 白框編輯器「導出分享」「導入 PNG / CSS」 | TXT / CSS |
| 白框預設集 | 我的預設「圖片分享」「圖片導入」 | SULLYCSS1 文本；原剪貼板分享保留 |
| 白框提示音 | 提示音編輯器「圖片分享」「圖片導入」 | SULLYSND1 文本；原剪貼板分享保留 |
| 日記 CSS | 日記外觀編輯器 | CSS |
| 氣泡主題 | 氣泡製作器的已存主題 | JSON |
| 外觀預設 | 外觀預設管理 | ZIP；兼容舊 JSON |
| 劇情預設 | 劇情預設庫、製作器及裝載入口 | JSON |
| 小屋樣板房 | 小屋樣板房導出 / 導入 | JSON |
| 像素小屋 | 像素家園底部導出 / 導入 | JSON |

PNG 內含原文件的完整字節，圖片本身不需要聯網才能恢復內容。內容中原有的外鏈仍然是外鏈。角色卡沿用現有字段剝離和本機圖片令牌轉資源流程；系統備份、診斷日誌、聊天記錄及直接下載的媒體仍走原有文件出口。

## 使用邊界

- 分享的是 PNG 原文件。截圖、重編碼、圖片壓縮、轉成 JPG/WebP 或刪除圖片元數據，可能丟失內容；建議按文件發送。
- 使用限制展示在圖片上並隨元數據保存，是作者說明，不是加密或權限控制。導入時仍執行對應功能原有的校驗、合併或覆蓋規則。
- 僅識別 SullyOS 分享卡，不把普通 PNG 或其它應用的角色 PNG 當作 SullyOS 數據導入。
- 預覽圖限制 20 MB / 4000 萬像素；內嵌內容上限 64 MB，整張 PNG 上限 96 MB。超限可用原格式導出。
- 作者、作品名、使用限制的編輯只作用於本次分享圖，不改動源角色/預設。預覽圖居中裁切；GIF 導出當前預覽幀。

## 實現

`utils/shareExport.ts` 的文本與 Blob 入口接受可選的 `card` 參數，按需加載分享編輯器。調用方應處理 `cancelled`，取消時不顯示成功提示。PNG 和原文件都複用原生分享 → Web Share → 瀏覽器下載的適配；Capacitor 的 `Share canceled` 和 Web Share 的 `AbortError` 都返回取消。

`utils/pngShare.ts` 在 IEND 前寫入私有輔助數據塊 `suLy`。佈局遵循 [W3C PNG 第三版](https://www.w3.org/TR/png-3/#5Chunk-layout)：8 字節 `SullyOS\0` 標識、4 字節大端元信息長度、UTF-8 JSON 元信息、原文件二進制字節。元信息包含 format/version/kind/title/author/restrictions/style/fileName/mimeType，不使用 base64 擴充原文件。

導入檢查 PNG 標識、分塊邊界、CRC、數據塊重複、協議版本、內容類型、文件名和體積，確認後還原 File 交給原功能導入。重新封裝時移除已有 `suLy`，防止殘留上一份分享內容。圖片 CRC 用於檢測損壞，不用於證明作者身份。擴展新內容類型時，需同時接入導出 `card.kind`、PNG 文件選擇器和 `readShareFile` / `readShareText`，再執行原內容校驗。

分享卡使用統一 Canvas 生成預覽，導出直接讀取這張 Canvas，因此文件與預覽逐像素一致。編輯器使用原生 dialog，支持鍵盤焦點限制、Escape 取消及減少動態效果偏好。移動端設置面板最高 320px，且不超過內容區高度的 46%；VisualViewport 變化時同步可用高度和位置，避免軟鍵盤遮住預覽、輸入項或導出按鈕。

## 驗證

```sh
node node_modules/vitest/vitest.mjs run utils/pngShare.test.ts utils/shareExport.test.ts utils/shareExportNative.test.ts utils/exportShareAudit.test.ts utils/characterCard.test.ts utils/exportGuard.test.ts utils/worldbook.test.ts utils/storyTheater.test.ts
node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 5188 --strictPort
node scripts/test-png-share-ui.mjs
```

UI 腳本使用 Playwright，可通過 `PLAYWRIGHT_MODULE` 指定其絕對模塊路徑，通過 `PNG_SHARE_BROWSER_CHANNEL=msedge` 使用已安裝的 Edge，通過 `PNG_SHARE_QA_URL` 修改測試地址。測試使用隔離瀏覽器存儲並阻止外部網絡請求；檢查三種佈局、真實圖片上傳、320px / 390px 屏幕上預覽與設置同時可見、獨立滾動、VisualViewport 鍵盤縮小模擬、收起展開保留編輯、長文案、像素一致性、下載、取消/重試、原 JSON、真實 CSS 編輯器往返和實際角色導入。結果在 `output/png-share-qa/`。可視區域模擬不等於 Android / iPhone 真機鍵盤測試。
