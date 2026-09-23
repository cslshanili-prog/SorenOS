# 小紅書集成 - 技術調試文檔

## 一、項目概覽

NOI2test 是一個虛擬手機 OS 模擬器（React + Vite），其中集成了小紅書自動化功能。
前端通過 `utils/xhsMcpClient.ts` 與後端通信，**支持兩種後端模式**。

---

## 二、兩種後端模式

### 模式 A: MCP 模式（JSON-RPC 2.0）

- **後端**: `xiaohongshu-mcp`（Go 語言，獨立項目）
- **GitHub**: https://github.com/xpzouying/xiaohongshu-mcp
- **協議**: MCP (Model Context Protocol)，基於 JSON-RPC 2.0 + SSE
- **啟動**: 獨立啟動 Go 二進制，監聽 18060 端口
- **前端 URL**: 需配置為 `http://localhost:18061/mcp`（通過 CORS 代理）
- **CORS 代理**: `scripts/mcp-proxy.mjs`（代理 18061 → 18060，修復 CORS 頭 + SPA 預熱）
- **Chrome 管理**: Go 服務自己管理 Chrome（用戶無需關心）

**MCP 模式的特殊處理**:
- 需要 `initialize` → `notifications/initialized` → `tools/list` 握手
- 需要 `Mcp-Session-Id` 頭（Go 服務返回，瀏覽器 CORS 限制需要代理暴露該頭）
- 工具名稱不一致問題：Go 服務的工具名可能是 `search`、`get_recommend` 等，前端通過 `TOOL_NAME_ALIASES` 和 `mcpResolveToolName` 做映射
- SSE 響應需要特殊解析（`mcpParseSseResponse`）

### 模式 B: Skills/Bridge 模式（REST API）

- **後端**: `xiaohongshu-skills`（Python，獨立項目）
- **GitHub**: https://github.com/autoclaw-cc/xiaohongshu-skills
- **橋接層**: `scripts/xhs-bridge.mjs`（Node.js HTTP 服務器，spawn Python CLI）
- **啟動**: `start-xhs.bat` 一鍵啟動（Chrome + Bridge + Cloudflared）
- **前端 URL**: 配置為 `http://localhost:18061/api`
- **Chrome 管理**: ⚠️ 這是當前的核心問題（見下文）

**Skills 模式的工作原理**:
```
前端 → HTTP POST /api/search → xhs-bridge.mjs → spawn `uv run python cli.py search-feeds --keyword xxx` → 返回 JSON
```

### 前端自動檢測模式

`xhsMcpClient.ts` 第 23-26 行：
```typescript
const detectMode = (serverUrl: string): BackendMode => {
    if (serverUrl.includes('/api')) return 'bridge';
    return 'mcp'; // default
};
```

- URL 包含 `/api` → Bridge 模式
- 其他 → MCP 模式

---

## 三、當前狀態和問題

### 正常工作的功能
- ✅ 發帖 (publish)
- ✅ 首頁 (list-feeds) — Python CLI 有額外 `time.sleep(1)`
- ✅ 分享功能
- ✅ check-login（能正確檢測登錄狀態）
- ✅ 搜索→詳情→評論→回覆（有 xsecToken 的正常流程）
- ✅ 搜索→點贊/收藏（有 xsecToken 的正常流程）

### 不工作的功能（已修復）
- ~~❌~~ ✅ 搜索 (search-feeds) — Bridge CDP fallback 已修復
- ~~❌~~ ✅ 用戶主頁 (user-profile) — Bridge CDP fallback 已修復

### 已修復的問題

#### ~~⚠️~~ ✅ 通過主頁查看筆記詳情時看不到評論區、無法評論/點贊（已修復）

**原現象**：AI 角色通過 `[[XHS_MY_PROFILE]]` 查看自己主頁 → 選一條筆記 `[[XHS_DETAIL: noteId]]` → 能看到筆記正文 → 但評論區為空 → 後續的 `[[XHS_COMMENT]]`、`[[XHS_LIKE]]` 等操作因缺少 xsecToken 而失敗。另外筆記列表也不顯示。

**根本原因鏈（已定位並修復）**：

1. **筆記列表不顯示（Bug 1）**：Bridge 模式返回 `{ code: 0, data: { notes: [...] } }`，但前端 `extractNotesFromMcpData()` 只查第一層 key，無法穿透 `data.data.notes` 嵌套結構，導致筆記列表始終為空。
   - **修復**：`extractNotesFromMcpData` 增加了 `data.data.*` 嵌套解包邏輯
   - **修復**：`useChatAI.ts` 在調用 `extractNotesFromMcpData` 前手動解包 `d.data || d`
   - **修復**：`profileStr` 改為只保留 `basic_info`（用戶簡介），避免整個 JSON 被 3000 字符截斷

2. **評論區為空（Bug 2）**：CDP fallback 只從 `__INITIAL_STATE__.note.noteDetailMap` 提取筆記元數據，但評論是異步 XHR 加載的，不在 SSR 初始狀態裡。
   - **修復**：`cdpFallbackFeedDetail` 重構為手動管理 tab 生命週期：提取筆記數據後保持 tab 打開 → 執行 JS 滾動頁面觸發評論 XHR → 等待評論 DOM 渲染 → 從 DOM 提取評論 → 合併到筆記數據 → 關閉 tab

3. **xsecToken 缺失**：主頁返回的筆記列表裡沒有 xsecToken，但 CDP 打開筆記詳情頁後能從 `noteDetailMap` 提取到 xsecToken 並緩存

**已實施的緩解措施（xhs-bridge.mjs）**：

- **xsecToken 內存緩存**：`cdpFallbackFeedDetail` 提取詳情時自動緩存 xsecToken，後續 `ensureXsecToken()` 先查緩存
- **CDP→CLI 重試**：`get-feed-detail` 在 CDP 拿到 xsecToken 後，自動用 CLI 重試（CLI 能通過 Playwright 滾動頁面加載評論）
- **CDP 直接提取評論**：`cdpFallbackFeedDetail` 滾動頁面後從 DOM 提取評論，即使 CLI 重試失敗也能拿到評論
- **前端也緩存 xsecToken**：`useChatAI.ts` 從 detail 響應中提取並緩存 token

**仍需注意**：
- CDP DOM 評論提取依賴小紅書前端的 CSS 選擇器，如果小紅書改版可能需要更新選擇器
- 整體流程較慢（CDP 提取 ~5s + 評論等待 ~5-10s），但比之前完全沒評論要好

### 已定位的根本原因：`_wait_for_initial_state` 競態條件

Python CLI（`xiaohongshu-skills`）的 `search.py` 中 `_wait_for_initial_state()` 只檢查：
```python
ready = page.evaluate("window.__INITIAL_STATE__ !== undefined")
```

但小紅書的 SSR 頁面**一加載就有** `__INITIAL_STATE__`（空殼），搜索/用戶主頁數據是**異步填充**的。
所以 CLI 一導航完就立刻讀到空數據返回了。

對比 `list_feeds`（能用）有額外的 `time.sleep(1)`，而 `search_feeds` 沒有。

**修復方式**: `xhs-bridge.mjs` 增加了 CDP 直連 fallback。
當 CLI 返回空結果時，bridge 通過 CDP WebSocket 直連 Chrome，輪詢等待 `__INITIAL_STATE__` 中的
數據實際填充後再提取（最多等 15 秒，每秒檢查一次）。

### 歷史問題：Chrome 瀏覽器管理衝突（已解決）

Python CLI（xiaohongshu-skills）內部有一個 `chrome_launcher` 模塊：
- 它會檢查指定端口（默認 9222）是否已有 Chrome 運行
- 如果沒有，它會**自動啟動一個新的 Chrome**
- 它使用自己的 profile 目錄（通常是 `~/.xhs/chrome-profile`）

---

## 四、文件清單

### 核心文件

| 文件 | 作用 |
|------|------|
| `scripts/start-xhs.bat` | Windows 一鍵啟動腳本（Chrome + Bridge + Cloudflared） |
| `scripts/xhs-bridge.mjs` | Node.js HTTP Bridge 服務器，封裝 Python CLI |
| `scripts/mcp-proxy.mjs` | MCP 模式的 CORS 代理（+SPA 預熱） |
| `utils/xhsMcpClient.ts` | 前端客戶端，雙模式（MCP/Bridge）自動切換 |

### 外部依賴（需用戶本地安裝）

| 項目 | 位置 | 用途 |
|------|------|------|
| `xiaohongshu-skills` | `scripts/xiaohongshu-skills/` | Python CLI，Bridge 模式後端 |
| `xiaohongshu-mcp` | 獨立運行 | Go MCP 服務器，MCP 模式後端 |
| `cloudflared.exe` | `scripts/cloudflared.exe` | 可選，用於公網隧道 |
| Chrome | 系統安裝 | 小紅書自動化（CDP 連接） |
| `uv` | 系統安裝 | Python 包管理器 |
| Node.js | 系統安裝 | 運行 Bridge/Proxy |

---

## 五、Bridge 模式 API 端點

`xhs-bridge.mjs` 提供以下 REST 端點（POST）：

| 端點 | CLI 命令 | 功能 |
|------|---------|------|
| `/api/check-login` | `check-login` | 檢查登錄狀態 |
| `/api/search` | `search-feeds --keyword xxx` | 搜索筆記 |
| `/api/list-feeds` | `list-feeds` | 首頁推薦 |
| `/api/get-feed-detail` | `get-feed-detail --feed-id xxx` | 筆記詳情+評論 |
| `/api/post-comment` | `post-comment --feed-id xxx --content xxx` | 發表評論 |
| `/api/reply-comment` | `reply-comment --feed-id xxx --content xxx` | 回覆評論 |
| `/api/like-feed` | `like-feed --feed-id xxx` | 點贊/取消 |
| `/api/favorite-feed` | `favorite-feed --feed-id xxx` | 收藏/取消 |
| `/api/user-profile` | `user-profile --user-id xxx --xsec-token xxx` | 用戶主頁 |
| `/api/publish` | `publish --title-file xxx --content-file xxx` | 發佈圖文 |
| `/api/publish-video` | `publish-video ...` | 發佈視頻 |
| `/api/long-article` | `long-article ...` | 發佈長文 |
| `/api/login` | `login` | 登錄（獲取二維碼） |
| `/api/get-qrcode` | `get-qrcode` | 獲取二維碼 |
| `/api/delete-cookies` | `delete-cookies` | 登出 |

所有端點都通過 `runCli()` 函數執行：
```
uv run python scripts/cli.py --host 127.0.0.1 --port 9222 <command> <args>
```

---

## 六、調試建議

### 1. 先搞清楚 Python CLI 的 Chrome 管理邏輯

```bash
# 查看 chrome_launcher 源碼
cat xiaohongshu-skills/scripts/chrome_launcher.py
# 或
cat xiaohongshu-skills/xhs/cdp.py
```

關鍵要確認：
- 連接端口 9222 時是否先檢測已有 Chrome？
- 如果已有 Chrome，是直接連接還是另起一個？
- `--user-data-dir` 路徑是什麼？

### 2. 測試 Chrome 連接

```bash
# 手動啟動 Chrome
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="%USERPROFILE%\.xhs\chrome-profile" --no-first-run https://www.xiaohongshu.com

# 然後手動測試 CLI 命令
cd xiaohongshu-skills
uv run python scripts/cli.py --host 127.0.0.1 --port 9222 check-login
uv run python scripts/cli.py --host 127.0.0.1 --port 9222 search-feeds --keyword "測試"
```

觀察 search-feeds 是否啟動了新的 Chrome 窗口。

### 3. 可能的解決方案

**方案 A**: 修改 bat，**不用 `--app` 模式**，改用普通窗口打開小紅書：
```batch
start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%CHROME_PROFILE%" --no-first-run https://www.xiaohongshu.com
```
（當前已經是這樣，如果還是空白頁，可能是 `--user-data-dir` 路徑有問題）

**方案 B**: 去掉 `--app=` 前綴試試（`--app` 會用 app 模式打開，可能不加載完整頁面）：
```batch
start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%CHROME_PROFILE%" --no-first-run "https://www.xiaohongshu.com"
```

**方案 C**: 不在 bat 裡啟動 Chrome，而是讓 bridge 在啟動後自動調用一次 `check-login` 或 `login`，讓 CLI 自己啟動 Chrome 並導航到小紅書。

**方案 D**: 在 bridge 啟動後，等 CLI 的 chrome_launcher 啟動 Chrome 後，在 Node.js 裡通過 CDP 協議發送導航命令到小紅書。

### 4. MCP 和 Skills 兼容性

兩種模式必須共存，因為：
- MCP 模式用 Go 服務（`xiaohongshu-mcp`），有自己的 Chrome 管理
- Skills/Bridge 模式用 Python CLI（`xiaohongshu-skills`），也有自己的 Chrome 管理
- 前端 `xhsMcpClient.ts` 通過 URL 自動判斷使用哪種模式
- 兩種模式**不會同時運行**，但代碼需要都支持

**不能破壞的東西**：
- MCP 模式的 `mcp-proxy.mjs`（CORS 代理 + SPA 預熱）
- Bridge 模式的 `xhs-bridge.mjs`（REST API → CLI spawn）
- 前端 `xhsMcpClient.ts` 的雙模式檢測和調用邏輯

---

## 七、關鍵日誌

啟動 bridge 後，觀察控制台輸出：

```
[bridge] $ uv run python scripts/cli.py --host 127.0.0.1 --port 9222 search-feeds --keyword xxx
[bridge] stderr: chrome_launcher: 啟動 Chrome (port=9222, headless=False)   ← ⚠️ 說明啟動了新 Chrome
[bridge] stderr: xhs.cdp: 導航到搜索頁...
[bridge] stdout (34 chars): { "feeds": [], "count": 0 }                     ← ❌ 空結果（新 Chrome 沒登錄）
[bridge] exit code: 0
```

正確的輸出應該是：
```
[bridge] stderr: xhs.cdp: 連接到已有 Chrome (port=9222)                    ← ✅ 連接已有
[bridge] stderr: xhs.cdp: 導航到搜索頁...
[bridge] stdout: { "feeds": [...], "count": 20 }                            ← ✅ 有結果
```

---

## 八、當前 start-xhs.bat 的 Chrome 啟動參數

```batch
start "" "%CHROME_EXE%" --remote-debugging-port=9222 --user-data-dir="%CHROME_PROFILE%" --no-first-run --app=https://www.xiaohongshu.com
```

其中 `CHROME_PROFILE` = `%USERPROFILE%\.xhs\chrome-profile`

**注意**：`--app=URL` 會以應用模式打開（無地址欄），如果出現空白頁，可能需要去掉 `--app=` 改為把 URL 作為普通參數傳入。

---

## 九、xsecToken 機制詳解

### 什麼是 xsecToken

小紅書的反爬機制之一。幾乎所有寫操作（評論、點贊、收藏）和筆記詳情 API 都需要 xsecToken。每條筆記有獨立的 xsecToken，且會過期。

### xsecToken 的獲取路徑

| 來源 | 何時可用 | 可靠性 |
|------|---------|--------|
| 搜索結果 `feeds[].xsecToken` | 搜索返回的筆記列表 | ✅ 最可靠 |
| 首頁推薦 `feeds[].xsecToken` | 首頁返回的筆記列表 | ✅ 可靠 |
| CDP `noteDetailMap[id].note.xsecToken` | 打開筆記詳情頁後 | ⚠️ 需等頁面加載 |
| URL 參數 `?xsec_token=xxx` | 從 URL 提取 | ⚠️ 不一定有 |
| 用戶主頁筆記列表 | 查看主頁時 | ❌ 通常沒有 |

### 緩存層次

```
前端 xsecTokenCacheRef (Map<noteId, token>)
  ↑ 搜索結果、首頁推薦、detail 響應
  ↑ findXsecToken() 查找

Bridge xsecTokenCache (Map<feedId, token>)
  ↑ cdpFallbackFeedDetail 提取時緩存
  ↑ cdpGetXsecToken 提取時緩存
  ↑ ensureXsecToken() 查找（用於 comment/like/fav）
```

### get-feed-detail 的完整流程

```
1. 前端調用 getNoteDetail(noteId, xsecToken?)
2. Bridge 收到請求
   ├─ 有 xsecToken（來自前端緩存或請求參數）
   │   └─ CLI get-feed-detail --feed-id xxx --xsec-token xxx
   │       ├─ 成功 → 返回（含評論）✅
   │       └─ 失敗 → 走下面的 CDP 路徑
   └─ 無 xsecToken
       └─ CDP 直連打開筆記頁
           ├─ 從 noteDetailMap 提取筆記數據
           ├─ 緩存 xsecToken（如果有）
           ├─ 有緩存 token → CLI 重試（能加載評論）✅
           └─ 無緩存 token → 返回 CDP 結果（無評論）⚠️
3. 前端收到響應
   ├─ 緩存 xsecToken（如果有）
   ├─ 緩存評論 userId/authorName
   └─ 發送給 AI 模型
```

### 為什麼主頁→詳情流程經常失敗

```
MY_PROFILE → cdpFallbackUserProfile → 返回 5 條筆記（無 xsecToken）
     ↓
AI 選擇一條筆記 → XHS_DETAIL: noteId
     ↓
findXsecToken(noteId) → undefined（主頁數據裡沒有）
     ↓
Bridge: 無 xsecToken → CDP 直連
     ↓
CDP 打開筆記頁 → 提取 noteDetailMap
     ├─ 有 xsecToken → 緩存 → CLI 重試（有評論）✅
     └─ 無 xsecToken → 返回 CDP 數據（無評論）⚠️
         ↓
     後續 LIKE/COMMENT → ensureXsecToken → 無緩存 → CDP 重新提取
         ├─ 成功 → 操作成功 ✅
         └─ 超時 → 操作失敗 ❌
```
