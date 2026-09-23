# 自定義 PWA 應用圖標

## 2026-09-14 原畫修訂

新版來自用戶的 logo2.png，重新生成 180 / 192 / 512 PNG 與獨立 maskable 圖；只等比縮放和留安全邊距。資源版本 38b1adde1d，主 manifest 地址和應用身份不變。經典圖標及用戶上傳圖標保留。

## 2026-09-13 內置圖標選擇

默認網頁圖標和 PWA 圖標改用用戶提供的水母原畫，按比例製作 180 / 192 / 512 PNG；maskable 版獨立留安全邊距。原來的圖標文件保留，通過「外觀 → 應用圖標 → PWA 應用圖標」選擇「經典」。已有上傳或鏈接圖標不會被新版默認覆蓋。

經典選擇仍存於 customIcons._pwa_，值為 builtin:classic；水母默認不存額外值。經典使用隨包的 manifest-classic.webmanifest，與主 manifest 保持相同 start_url / scope。自定義上傳繼續走 blobRef 與備份管線。

當前實現更新：普通瀏覽器和 standalone 均更新 manifest，確保安裝前選擇生效；舊文中“非 standalone 不更新 manifest”的描述已被本節取代。異步圖標加載帶版本校驗，慢請求不能覆蓋後一次選擇或重置。

迴歸：utils/appIcon.test.ts；scripts/test-app-icon-choice.mjs 覆蓋二選一、刷新、自定義上傳、重置和 320px 佈局。

## 這是什麼

用戶在「外觀定製 → 應用圖標」裡上傳一張圖（或填圖床鏈接），直接當 SullyOS 的主屏圖標用。
iOS 和 Android 兩邊都支持，不需要把圖傳到公網。

## 怎麼做到的

啟動時 JS 動態注入兩樣東西：

| 平台 | 注入點 | 怎麼寫 |
|------|--------|--------|
| iOS | `<link rel="apple-touch-icon">` | `href` 直接寫 `data:image/png;base64,...` |
| Android / Chrome | `<link rel="manifest">` | 用 `URL.createObjectURL(new Blob(...))` 生成臨時 manifest，圖標 `src` 寫 data: URI |

2026-08-04 真機實測 iOS 26.5.2 和 Android 17 (Chrome, Pixel 8) 都認 data: URI，兩端全通。

## 已安裝圖標更新取決於平台（2026-09-14 更正）

功能和網頁資源可隨正常更新加載，無需卸載。主屏圖標屬於安裝元數據，不能保證即時同步：

- Android Chrome 安裝的 WebAPK 支持檢查穩定 manifest 並更新 icons；通常需要啟動過應用並等待系統調度。
- iOS / iPadOS 的已安裝主屏圖標通常需要重新添加才更新。
- 自定義圖標使用臨時 blob manifest，無法承諾現有安裝會自動同步；圖標選擇首先保障下一次安裝。

依據：[Chrome manifest 更新](https://web.dev/articles/manifest-updates)、[PWA 更新機制](https://web.dev/learn/pwa/update)。不要改變 manifest URL、start_url 或應用身份來強迫刷新。本次只給默認圖標資源加內容版本查詢參數。

若為更換圖標而卸載或重新添加，先從現有 PWA 導出完整備份並確認文件保存；尤其不要假定 iOS 主屏應用與 Safari 共享存檔。

## 涉及的文件

### 新建

| 文件 | 幹什麼 |
|------|--------|
| `utils/appIcon.ts` | 注入/清除 PWA 圖標的核心邏輯：讀 blobRef 令牌→解出 data URL→寫進 DOM |
| `components/appearance/AppIconEditor.tsx` | 上傳/鏈接切換、預覽、環境感知警告 |

### 改動

| 文件 | 改什麼 |
|------|--------|
| `apps/Appearance.tsx` | 「應用圖標」標籤頁頂部塞 PWA 圖標卡片 |
| `context/OSContext.tsx`（輕量） | 啟動時讀已保存的 PWA 圖標並注入；提供讀取入口 |

## AppIconEditor 的 UI

### 模式切換

提供兩個 tab 切換，同一時間只展示一種：

- **上傳圖片**：文件選擇器（accept image），選完即時預覽
- **填入鏈接**：文本輸入框，輸完點「確認」拉圖並預覽

### 環境感知提示

按瀏覽器 / standalone 顯示簡短說明：標籤頁及下次安裝使用當前選擇；已安裝圖標由平台更新，功能更新無需重裝。如需重新添加，先導出完整備份。不要再把所有平台統一寫成“只能卸載重裝”。

### 圖標狀態

- 已經設了自定義圖標 → 顯示當前圖標預覽 + 「重置為默認」按鈕
- 沒設過 → 顯示默認圖標 + 引導文字

## appIcon.ts 的接口

```ts
// 把 blobRef 令牌解成 data URL 並注入 DOM。
// standalone 下同時替換 manifest 和 apple-touch-icon；
// 非 standalone 下只換 apple-touch-icon（瀏覽器標籤頁圖標）。
async function injectPwaIcon(blobRef: string): Promise<void>

// 恢復默認圖標（刪掉注入的 link/manifest，指回原始文件）。
function clearPwaIcon(): void

// 啟動時調用：檢查是否有已保存的 PWA 圖標，有就注入。
async function initPwaIcon(customIcons: Record<string, string>): Promise<void>
```

內部細節：
- manifest 替換要處理路徑問題：`blob:` URL 的 manifest 裡所有相對路徑都會相對 blob 解析導致 404，所以動態 manifest 裡的 `start_url`、`scope`、備用圖標等全部折成絕對地址
- `apple-touch-icon` 直接設 `data:` URI，沒有路徑解析問題
- manifest 只在 `display-mode: standalone` 時替換——瀏覽器裡替換 manifest 沒意義，還可能在 DevTools 裡刷出一堆 blob URL 干擾調試

## 存儲

複用現有 `customIcons` 體系，appId 用特殊值 `_pwa_`：

- `setCustomIcon('_pwa_', blobRef)` — 存圖
- `setCustomIcon('_pwa_', undefined)` — 重置
- 圖走 `blobRef` 管線：壓縮後的 Blob 存 IndexedDB blob_assets，字段裡只存 `blobref:...` 令牌
- 備份導出鏈路已通：`resolveBlobRefsDeep` 會把 `_pwa_` 的令牌轉回 data URL，跟其他自定義圖標一起打進備份包

## 不想做的

- 不按角色換圖標——通知圖標來自 `showNotification` 的 `icon` 字段（Android）或 PWA 主屏圖標（iOS），不是前端能動態改的
- 不做圖標裁切/編輯器——傳圖前自己裁好，組件裡只做等比縮放和壓縮
- 圖的大小上限 512px（跟現有 `handleIconUpload` 一樣），覆蓋 180、192、512 三個尺寸需求
