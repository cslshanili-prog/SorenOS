# 後台保活方案調研

> 問題：用戶在等待 AI 聊天回覆時，離開頁面（切換標籤頁/最小化/切到其他 App）會導致請求中斷或頁面被回收，丟失回覆。

## 當前項目現狀

| 項目 | 情況 |
|---|---|
| 框架 | React 18 + Vite 5 |
| 平台 | Web + Android（Capacitor 6） |
| 聊天 API | `safeFetchJson` → OpenAI 兼容 `/chat/completions`，**非流式**（`stream: false`） |
| 現有 Worker | `worker/index.js`（Cloudflare Worker，做 API 代理/搜索/小紅書橋接） |
| Service Worker | **無** |
| 後台處理 | **無** |

**關鍵特徵**：每次聊天請求是一個普通的 `fetch` POST，等待完整 JSON 返回。耗時可能幾秒到幾十秒。非流式意味著我們只需要保證這個 fetch 能完成即可，不需要維持長連接。

---

## 方案一覽

### 1. Service Worker + Background Fetch/Sync ⭐ 推薦 Web 端方案

**原理**：註冊一個 Service Worker，將聊天請求委託給 SW 處理。SW 在獨立線程運行，不受頁面可見性影響。即使用戶切走標籤頁，SW 仍可完成 fetch 並緩存結果到 IndexedDB/Cache API。用戶回來時直接讀取。

**實現思路**：
```
頁面發送消息 → postMessage 給 SW → SW 發起 fetch →
→ 結果存入 IndexedDB → 頁面回來時讀取
```

**細分 API**：
- **Background Sync API**：頁面註冊 sync 事件，SW 在網絡恢復時執行。適合離線場景，但我們的場景更適合直接在 SW 裡 fetch。
- **Background Fetch API**：適合大文件下載，有進度條 UI。對聊天 JSON 來說殺雞用牛刀。
- **直接在 SW 裡 fetch**：最簡單直接，SW 收到 message 後直接 fetch，完成後 postMessage 回頁面或存 IndexedDB。

**優點**：
- Web 通用，不依賴原生
- 實現相對簡單（項目目前沒有 SW，需要新增）
- 完美適配非流式請求
- 可以複用 safeApi.ts 的重試邏輯

**缺點**：
- 瀏覽器可能在極端低內存時殺掉 SW（但通常 30 秒內的請求沒問題）
- iOS Safari 對 SW 支持有限（後台 3 秒左右可能被殺）
- 需要 HTTPS（Capacitor 的 `androidScheme: "https"` 已滿足）

**兼容性**：Chrome/Edge/Firefox 全支持，Safari 支持基本 SW 但後台行為受限。

---

### 2. Capacitor 原生後台插件 ⭐ 推薦 Android 端方案

**2a. Android Foreground Service（最可靠）**

使用 `@capawesome-team/capacitor-android-foreground-service`，啟動一個前台服務+持久通知。Android 不會殺有前台服務的進程。

```
用戶發消息 → 啟動前台通知 "正在思考中..." → fetch 完成 → 關閉通知
```

**優點**：Android 上最可靠，系統不會殺進程，可以無限後台運行
**缺點**：需要顯示通知欄通知，僅 Android

**2b. @capacitor/background-runner（官方插件）**

**優點**：官方維護
**缺點**：最小間隔 15 分鐘，每次只有 30 秒執行時間，不適合即時聊天場景

**2c. capacitor-persistent-notification**

類似前台服務方案，JS 層寫後台邏輯。僅 Android。

**推薦**：2a（前台服務）最適合本項目。

---

### 3. Page Visibility API + fetch keepalive

**原理**：監聽 `visibilitychange`，當頁面進入後台時，用 `fetch(url, { keepalive: true })` 或 `navigator.sendBeacon()` 發送請求。`keepalive: true` 告訴瀏覽器即使頁面關閉也要完成請求。

```js
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    // 如果有進行中的請求，標記需要 keepalive
    // 新請求使用 keepalive: true
  }
});
```

**優點**：
- 零依賴，幾行代碼搞定
- 不需要 SW
- `keepalive: true` 確保 fetch 在頁面卸載後仍能完成

**缺點**：
- `keepalive` 請求體上限 64KB（我們的聊天 payload 可能超過，因為帶大量歷史消息）
- 只能保證請求**發出**，但如果頁面被回收了，response 也接收不到
- 不能處理"請求已發出，等待回覆"的情況
- 結果接收是個問題——頁面被殺後回來怎麼拿到結果？

**評估**：作為輔助手段可以，但單獨使用不夠。

---

### 4. Web Lock API

**原理**：持有 Web Lock 的頁面，瀏覽器會**儘量**不回收。

```js
navigator.locks.request('chat-in-progress', async () => {
  // 在這裡做 fetch，持有鎖期間瀏覽器不太會凍結頁面
  const result = await fetch(...)
});
```

**優點**：一行代碼
**缺點**：
- W3C 規範明確說瀏覽器**可以**釋放後台頁面的鎖，這只是個"建議"不是保證
- 實際測試中 Chrome 確實會更晚凍結持鎖頁面，但不是 100% 可靠
- Safari 不支持
- 不解決"頁面被回收後結果去哪"的問題

**評估**：錦上添花，不能作為主方案。

---

### 5. WebSocket 保持連接

**原理**：瀏覽器對有活躍 WebSocket 連接的標籤頁不做節流。可以用 WebSocket 替代 HTTP fetch 來發送聊天請求。

**優點**：
- Chrome 明確不節流有 WebSocket 的頁面
- 可以順便支持流式響應
- 實時性好

**缺點**：
- 需要後端支持 WebSocket（當前用的是 OpenAI 兼容 API，不走 WS）
- 架構改動大
- 中間代理（Cloudflare Worker）也要改
- 不解決 iOS 後台掛起的問題

**評估**：如果未來要做流式輸出，可以考慮。當前改動太大。

---

### 6. 靜音音頻播放（Hack）

**原理**：播放一段無聲音頻，瀏覽器認為頁面在播放媒體，不會節流。

```js
const audio = new Audio('data:audio/wav;base64,...'); // 極短無聲音頻
audio.loop = true;
audio.volume = 0.01;
audio.play();
```

**優點**：簡單粗暴，大多數瀏覽器有效
**缺點**：
- Hack，不是正規做法
- 可能被未來瀏覽器更新封殺
- 移動端可能有電量影響
- 狀態欄會顯示音頻播放圖標

**評估**：緊急方案/兜底方案，不推薦長期使用。

---

### 7. SharedWorker

**原理**：SharedWorker 可被多個標籤頁共享，只要有一個標籤頁存活，Worker 就不會被殺。在 SW 裡管理聊天請求。

**優點**：不依賴頁面生命週期
**缺點**：Safari 不支持（2023 年開始支持了，但 iOS Safari 仍不支持），Android WebView 不支持

**評估**：對 Capacitor 應用不實用。

---

## 方案對比矩陣

| 方案 | 可靠性 | 改動量 | Web 兼容 | Android | iOS | 推薦度 |
|---|---|---|---|---|---|---|
| **Service Worker** | ★★★★ | 中 | ✅ | ✅ | ⚠️ 受限 | ⭐⭐⭐⭐⭐ |
| **Android 前台服務** | ★★★★★ | 中 | ❌ | ✅ | ❌ | ⭐⭐⭐⭐⭐ (Android) |
| **Visibility + keepalive** | ★★ | 小 | ✅ | ✅ | ✅ | ⭐⭐⭐ |
| **Web Lock** | ★★ | 極小 | ✅ | ✅ | ❌ | ⭐⭐ |
| **WebSocket** | ★★★★ | 大 | ✅ | ✅ | ⚠️ | ⭐⭐ |
| **靜音音頻** | ★★★ | 極小 | ✅ | ✅ | ✅ | ⭐⭐ |
| **SharedWorker** | ★★★ | 中 | ⚠️ | ❌ | ❌ | ⭐ |

---

## 推薦實施方案

### 第一階段：快速見效（1-2 小時）

**Visibility API + Web Lock + keepalive 組合**

```typescript
// utils/backgroundKeepAlive.ts

let chatLock: Promise<void> | null = null;

export function withKeepAlive<T>(fetchFn: () => Promise<T>): Promise<T> {
  // 1. 請求 Web Lock（如果可用）
  if ('locks' in navigator) {
    chatLock = navigator.locks.request('ai-chat', { mode: 'exclusive' }, async () => {
      // 鎖會持續到 fetch 完成
      await fetchFn();
    });
  }

  // 2. 監聽頁面隱藏
  const onHide = () => {
    // 頁面進入後台時的處理邏輯
    console.log('[KeepAlive] 頁面進入後台，請求繼續中...');
  };
  document.addEventListener('visibilitychange', onHide);

  return fetchFn().finally(() => {
    document.removeEventListener('visibilitychange', onHide);
    chatLock = null;
  });
}
```

### 第二階段：Service Worker 方案（半天-1天）

1. 新建 `public/chat-sw.js` — 聊天專用 Service Worker
2. 在 `useChatAI.ts` 中註冊 SW
3. 聊天請求通過 `postMessage` 委託給 SW
4. SW 完成 fetch 後將結果存入 IndexedDB
5. 頁面恢復後從 IndexedDB 讀取結果

```
[頁面] --postMessage--> [SW] --fetch--> [API]
                         |
                    [IndexedDB]  <-- 結果緩存
                         |
[頁面恢復] --讀取--> [IndexedDB]
```

### 第三階段：Android 原生加持（可選）

1. 安裝 `@capawesome-team/capacitor-android-foreground-service`
2. 聊天請求發起時啟動前台服務
3. 請求完成後關閉前台服務
4. 通知欄顯示 "AI 思考中..."

---

## iOS 特殊說明

iOS 是最難處理的平台。Safari 和 iOS WebView 在進入後台 ~3 秒後會凍結所有 JS 執行和網絡請求。目前沒有完美的純前端方案。可選：

1. **Push Notification**：後端處理完後推送通知，用戶點通知回到 App
2. **Background URL Session**（需要 Capacitor 原生插件，類似 iOS NSURLSession 後台模式）
3. **接受限制**：在 UI 上提示用戶"請勿離開頁面"，並在回來時自動重試

---

## 結論

**最實際的路徑**：

1. **立刻做**：Visibility API + Web Lock 組合（幾行代碼，立刻有改善）
2. **短期做**：Service Worker 方案（Web + Android 都能受益）
3. **按需做**：Android 前台服務（Capacitor 原生，最可靠）
4. **長期考慮**：Push Notification（解決 iOS 問題）

---

## 參考資料

- [Background Synchronization API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Synchronization_API)
- [Background Fetch API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Background_Fetch_API)
- [Page Visibility API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Page_Visibility_API)
- [Web Locks API - MDN](https://developer.mozilla.org/en-US/docs/Web/API/Web_Locks_API)
- [Inactive Tab Throttling in Browsers](https://aboutfrontend.blog/tab-throttling-in-browsers/)
- [Capacitor Background Runner](https://capacitorjs.com/docs/apis/background-runner)
- [Android Foreground Service Plugin](https://capawesome.io/plugins/android-foreground-service/)
- [@capawesome/capacitor-background-task](https://github.com/capawesome-team/capacitor-background-task)
- [Periodic Background Sync - web.dev](https://web.dev/patterns/web-apps/periodic-background-sync)
- [Offline and background operation - MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Offline_and_background_operation)
