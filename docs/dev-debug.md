# Dev Debug 調試子系統

開發分支專用的"工具箱"：一個懸浮按鈕 + 面板，放一堆**只在開發分支顯示**的調試開關，外加一套可選的「分類捕獲」日誌——打開**總開關**「記錄日誌」後會露出並排的類型 checkbox（目前 `api` 普通聊天 / `amsg` 主動消息收發鏈路 / `lifecycle` 前後台 / `memory-palace` 記憶召回），勾哪類抓哪類。面板走極簡：類型並排、無逐條說明（看不懂就別用）。正式分支（main / master）默認整個隱藏，用戶看不到也不會誤觸。

這份文檔講清楚它怎麼運作，以及**怎麼往裡加新開關 / 加一類捕獲日誌**——照著步驟抄就行。

---

## 一、它什麼時候出現？（可用性門禁）

整套能力（面板、開關存儲、日誌捕獲）都掛在一個總開關後面：

```ts
isDevDebugAvailable()  // utils/devDebug.ts
  → !forceClosed && (__BUILD_BADGE_VISIBLE__（vite 構建注入）|| manualUnlock（連點解鎖·會話級）)
```

`__BUILD_BADGE_VISIBLE__` 在 `vite.config.ts` 裡算出來，規則如下：

| 情況 | 是否顯示 |
|------|---------|
| 在 `main` / `master` 構建 | ❌ 隱藏（視為正式發佈） |
| 在其他分支構建 | ✅ 顯示 |
| 設了 `VITE_HIDE_BUILD_BADGE=1` | ❌ 強制隱藏（覆蓋默認） |
| 設了 `VITE_SHOW_BUILD_BADGE=1` | ✅ 強制顯示（在 master 本地調試用） |
| 設置頁底部連點「構建版本」5 下 | ✅ 顯示（**手動解鎖**，會話級、刷新即關，正式版臨時排障用） |

> 分支名的來源：CI 優先讀 `GITHUB_REF_NAME` / `VERCEL_GIT_COMMIT_REF` / `CF_PAGES_BRANCH` / `BRANCH`，本地退化成 `git rev-parse --abbrev-ref HEAD`，非 git 環境是 `'unknown'`（`'unknown'` 不在發佈分支集合裡，所以會顯示）。

**關鍵含義**：在 master 上本地想調試，跑 `VITE_SHOW_BUILD_BADGE=1 pnpm dev` 即可，不用改代碼。

**正式版排障（手動解鎖）**：設置頁底部連點 `VersionInfo`（構建版本那欄）5 下 → `unlockDevDebug()` **會話級**解鎖（**不落 localStorage**），`isDevDebugAvailable()` 放行、`<DevDebugPanel />` 經 `subscribeDevDebugAvailability` 即時彈出。

**怎麼關掉**：
- **刷新頁面**：`manualUnlock` 清零 → prod 回到隱藏；非 prod 因 `__BUILD_BADGE_VISIBLE__` 默認可見，刷新後照常顯示（即「非 prod 一直開」）。
- **面板底部「關閉」按鈕**：`closeDevDebug()` 置 `forceClosed`，**任意分支**強制關掉；會話級，**刷新後非 prod 自動恢復**。順手把浮球位置收回默認、面板收起；**`isCaptureEnabled` 跟 `isDevDebugAvailable` 綁定**——只要面板看不見（關閉 / prod 未解鎖 / prod 解鎖後刷新 / 非 prod 強制關閉）都返 false，避免業務代碼繼續往 localStorage 寫日誌的隱私債。**裡面的捕獲 / 行為開關存檔不動**——刷新恢復後可見性回來，裡面勾的還是原樣，但只有面板可見時才真正錄。

> 可用性 = `!forceClosed && (__BUILD_BADGE_VISIBLE__ || manualUnlock)`，三個量裡只有 `__BUILD_BADGE_VISIBLE__` 是構建期常量，另兩個是會話級內存標誌（刷新歸零）。

> **面板自身狀態全是純內存、不落盤**：浮球位置、展開與否每次出現都回默認（位置默認角、收起）；prod 刷新 = 解鎖失效 ≈ 手動關閉，所以位置沒必要持久化。裡面的捕獲 / 行為開關是另一套 localStorage，跟這些無關。

---

## 二、相關文件清單

| 文件 | 職責 |
|------|------|
| `utils/devDebug.ts` | 核心：類型、存儲讀寫、事件、分類捕獲、便捷 getter。**所有邏輯都在這** |
| `components/DevDebugPanel.tsx` | 懸浮按鈕 + 面板 UI（拖拽、開關行、複製 / 下載日誌、重置） |
| `components/settings/VersionInfo.tsx` | 設置頁底部版本腳註（APP_VERSION + build hash + UTC+8 構建時間 + sw 版本）；連點 5 下手動解鎖面板 |
| `utils/swVersion.ts` | `querySwVersion()`：向 SW 查版本號（BuildBadge / VersionInfo 共用） |
| `App.tsx` | 掛載 `<DevDebugPanel />`（無腦掛，組件內部自己判斷要不要渲染） |
| `vite.config.ts` | 注入 `__BUILD_BRANCH__` / `__BUILD_COMMIT__` / `__BUILD_TIME__` / `__BUILD_BADGE_VISIBLE__` |
| `vite-env.d.ts` | 上面四個常量的 TS 聲明 |

消費現有開關的地方（改開關行為時要一起看）：

| 開關 | 消費點 |
|------|--------|
| `skipPromptBuild` | `utils/chatRequestPayload.ts:266` |
| `skipEmotionEval` | `context/OSContext.tsx`（`isEmotionEvalSkipped()`）、`hooks/useChatAI.ts`（`emotionEvalEnabled`） |
| `mergeSystemMessages` | `utils/chatRequestPayload.ts`（fullMessages 組裝末尾）+ `utils/systemMessageMerge.ts` |
| 捕獲類 `api` | `utils/safeApi.ts`（調 `appendDevDebugApiLog`，普通聊天直發 + Character 的記憶精煉/歸檔/導入/批量總結/印象生成，凡走 `safeFetchJson` 的 chat completions 都算） |
| 捕獲類 `amsg` | `utils/activeMsgRuntime.ts`（模塊頂 `makeDebugLogger('amsg', …)` + `activeMsgTrace` 鏡像） |
| 捕獲類 `lifecycle` | `utils/devDebug.ts` 自帶的 `installDevDebugLifecycleCapture()`（`App.tsx` 啟動時掛一次，監聽器常駐、抓不抓走門禁） |
| 總開關 `captureEnabled` | `utils/devDebug.ts` 的 `isCaptureEnabled()` 閘門——關掉時所有捕獲類都不抓 |

---

## 三、兩類開關的區別

面板裡的開關分兩種，加法不一樣，別搞混：

| 類型 | 例子 | 數據形態 | 加新的成本 |
|------|------|---------|-----------|
| **行為開關（skip 型）** | `skipPromptBuild` / `skipEmotionEval` | `DevDebugFlags` 裡一個 `boolean` | 改 flag 結構（見指南 A） |
| **捕獲類（checkbox）** | `api` / `amsg`（未來 `mcp`…） | 進 `captureLogs: Category[]` 數組 | 加一行 category + 一個薄封裝，flag 結構不動（見指南 B） |

> 還有個**總開關** `captureEnabled`（本質也是個 boolean 行為開關）：勾選只是「選類型」，真正抓不抓 = `captureEnabled && captureLogs.includes(category)`。面板上**總開關用 switch、類型用並排 checkbox**，且**總開關打開後才露出類型 checkbox**（無逐條說明）。

> **面板文案約定（用就默認看得懂）**：標題寫清"是什麼"；說明（`detail`）只留**非顯而易見的坑**，能省則省、不寫教程。能從標題猜到的（總開關、類型 checkbox）乾脆不寫說明。例：「記錄完整內容」說明只留一句「只對新條目生效」——為什麼摺疊、怎麼導出這些寫在 doc（第六、第九節），不擠進面板。新增開關 / 類別時照此辦，詳盡解釋放 doc、面板只留必要提示。

捕獲類共用同一套底座（存儲、脫敏、限容、複製 / 下載），所以加新類很便宜——這也是為什麼日誌系統設計成"分類"而不是給每種日誌單獨開一個 boolean。

---

## 四、數據流總覽

```
DevDebugPanel (UI)
   │  點開關
   ▼
writeDevDebugFlags(flags)
   │  寫 localStorage（按分支隔離的 key）
   │  派發 DEV_DEBUG_EVENT 自定義事件
   │  ⚠️ 取消勾選「不」清日誌（勾選是純選擇）；清日誌只在「重置」時做
   ▼
業務代碼調 isXxxSkipped() / isCaptureEnabled('api' | 'amsg')
   │  閘門 = captureEnabled（總開關）&& 該類已勾
   │  每次都現讀 localStorage，拿到最新值
   ▼
按 flag 改變行為（跳過某步 / 抓日誌）

跨標籤頁同步：localStorage 的 'storage' 事件
面板內實時刷新：subscribeDevDebugFlags() / subscribeDevDebugLog()
```

**為什麼用事件 + 現讀 localStorage，而不是 React state 全局共享？**
因為消費方大多是普通函數（不是組件），拿不到 React context。所以約定成：**寫的時候持久化 + 廣播事件，讀的時候直接讀存儲**。組件想跟著變就 `subscribe`。

---

## 五、存儲 key（都按分支隔離）

每個 key 實際存進 localStorage 時會拼上當前分支後綴，避免不同分支的調試狀態互相汙染：

```
sullyos.devDebug.flags.v1.<branch>      ← 開關狀態（含 captureLogs 數組）
sullyos.devDebug.log.v1.<branch>        ← 分類捕獲日誌（各類混存，每條帶 category 字段）
```

> 浮球位置 / 展開與否**不落 localStorage**（純內存，刷新即回默認）；可用性（解鎖 / 強制關閉）也是會話級內存標誌。只有上面這兩個 key 真正持久化。

`<branch>` 由 `__BUILD_BRANCH__` 歸一化而來（非字母數字 `._-` 的字符替換成 `_`）。

---

## 六、現有開關

| 開關 | 類型 | 作用 | 副作用 |
|------|------|------|--------|
| `skipPromptBuild` | 行為 | 只發聊天歷史，不注入 system prompt | 雙語 / MCD / HTML / thinking 等增強全部關掉 |
| `skipEmotionEval` | 行為 | 主回覆照常，但不跑情緒副評估（本地和即時對話都算） | 關掉後情緒不更新 |
| `mergeSystemMessages` | 行為 | 把聊天請求的多條 `role:system`（穩定前綴 / 易變尾段 / 雙語·MCP 提醒條）合併成開頭一條再發送（`utils/systemMessageMerge.ts`）。用途：A/B 對照中轉適配層對多 system 請求的計量——同一段聊天開關各發一條，對比中轉記的 prompt_tokens；合併後驟降 = 中轉把「歷史後的 system」重複拼接了 | 易變尾段失去 recency 位置、穩定前綴緩存失效；只作臨時排障，測完關掉 |
| `captureEnabled`<br>（記錄日誌·總開關） | 行為 | 日誌錄製總閘：關掉時所有捕獲類都不抓 | 默認關；關掉只是停錄，**不清**已抓日誌 |
| 捕獲類 `api` | 捕獲 | 抓所有走 `safeFetchJson`（`safeApi`）的 chat completions 請求 + 響應：普通聊天直發，外加 Character 裡的記憶精煉/強制歸檔/導入清洗/批量總結/印象生成。每條帶 `durationMs`（最後一次 attempt 從發起到成功/報錯的耗時）和 `requestChars`（請求體字符數，messages 摺疊後靠它看體積） | 取消勾選只停此後抓取，**不清**已有日誌 |
| 捕獲類 `amsg` | 捕獲 | 抓主動消息 2.0 的收發鏈路：收件箱沖刷、推送落庫、即時對話回合的 trace（`[ActiveMsg]` / `[amsg]` 兩個 tag） | 同上，取消勾選不清日誌 |
| 捕獲類 `lifecycle` | 捕獲 | 抓頁面前後台/焦點/網絡狀態變化：`visibilitychange`、`focus`/`blur`、`pagehide`/`pageshow`（含 bfcache `persisted` 標記）、`online`/`offline`、`freeze`/`resume`（Chromium 系）。跟 api 類對時間線用——API 報錯前後緊挨著 `visibilitychange → hidden`，基本就是切後台/鎖屏把 fetch 凍死的 | 同上，取消勾選不清日誌 |
| `exposeLogDetail`<br>（記錄完整內容） | 抓取 | 關（默認）：`messages` 聊天歷史數組整組換成一句 `…共 N 項（已摺疊）`；開：整段存 | 影響**抓取 / 存儲**；要完整須復現前打開，已抓的摺疊版不可還原 |

捕獲日誌：各類**混存在一個數組**裡、每條帶 `category`，全局最多留 **100 條 / 1 MB**（先到先淘汰）。因為長文本在寫入時就摺疊了（見第九節），實際存的是瘦身版、很省空間，1 MB 基本撐不爆、輕鬆存滿 100 條；導出（複製 / 下載）默認導全部、自動帶上當前分支 + commit，並對密鑰字段脫敏。

---

## 七、操作指南 A：加一個行為開關（skip 型）

以加 `skipMemoryRecall`（跳過記憶召回）為例，只動 2 個文件。

### 1. `utils/devDebug.ts` —— 加字段 + 默認值 + 歸一化 + 便捷 getter

```ts
export interface DevDebugFlags {
    skipPromptBuild: boolean;
    skipEmotionEval: boolean;
    captureLogs: DevDebugCaptureCategory[];
    skipMemoryRecall: boolean;        // ← 新增
}

export const DEFAULT_DEV_DEBUG_FLAGS: DevDebugFlags = {
    skipPromptBuild: false,
    skipEmotionEval: false,
    captureLogs: [],
    skipMemoryRecall: false,          // ← 新增，行為開關一律默認 false
};

// normalizeFlags 裡也要加一行（防止舊 localStorage 缺字段讀出 undefined）
function normalizeFlags(value: unknown): DevDebugFlags {
    const source = ...;
    return {
        skipPromptBuild: source.skipPromptBuild === true,
        skipEmotionEval: source.skipEmotionEval === true,
        captureLogs: normalizeCaptureLogs(source.captureLogs),
        skipMemoryRecall: source.skipMemoryRecall === true,   // ← 新增
    };
}

export function isMemoryRecallSkipped(): boolean {
    return readDevDebugFlags().skipMemoryRecall;
}
```

> ⚠️ 三處一定都要改：`DevDebugFlags`、`DEFAULT_DEV_DEBUG_FLAGS`、`normalizeFlags`。漏了 `normalizeFlags`，老用戶存檔裡沒這字段，讀出來是 `undefined`，行為不可控。

### 2. `components/DevDebugPanel.tsx` —— 在兩個 skip 開關下面照抄一行

```tsx
<ToggleRow
    title="跳過記憶召回"
    detail="不注入歷史記憶，用來隔離記憶相關的問題。"
    checked={flags.skipMemoryRecall}
    onChange={(checked) => updateFlag('skipMemoryRecall', checked)}
/>
```

`activeCount`（浮球小紅點）已經按 `skipPromptBuild + skipEmotionEval + captureLogs.length` 累加——加一個新 skip 字段要順手把它也加進 `activeCount` 的算式裡。

### 3. 在業務代碼裡消費

```ts
import { isMemoryRecallSkipped } from '../utils/devDebug';

if (isMemoryRecallSkipped()) {
    console.warn('[DevDebug] Memory recall skipped.');
    return [];
}
```

> 習慣：開關命中時打一條 `console.warn('[DevDebug] ...')`，方便在控制台確認開關真生效了（參考 `chatRequestPayload.ts:158`）。

---

## 八、操作指南 B：加一類捕獲日誌（checkbox）

捕獲類共用底座，加新類**不用碰 `DevDebugFlags` 結構**，面板也會自動多出一個開關。以加一類 `mcp`（抓 MCP 工具調用）為例：

### 1. `utils/devDebug.ts` —— 加 category + 元信息

```ts
export type DevDebugCaptureCategory = 'api' | 'amsg' | 'mcp';   // ← 加一個字面量

export const DEV_DEBUG_CAPTURE_CATEGORIES: DevDebugCaptureCategoryMeta[] = [
    { key: 'api', title: 'API（普通聊天請求）', detail: '...' },
    { key: 'amsg', title: '主動消息', detail: '...' },
    { key: 'mcp', title: '記錄 MCP 調用', detail: '抓 MCP 工具的入參和返回。' },  // ← 加一行
];
```

> 面板靠遍歷 `DEV_DEBUG_CAPTURE_CATEGORIES` 渲染並排 checkbox，加了這一行就自動多一個，**不用動 Panel 代碼**。注意：面板只用 `title` 當短標籤，`detail` 現在不渲染（僅作源碼文檔）。

### 2.（可選）寫一個語義化薄封裝

底層 `appendDevDebugLog(category, { label, data })` 已經夠用，但給每類包一層薄封裝調用更順手、字段更整齊（參考文件末尾的 `appendDevDebugApiLog`，HTTP 形狀的可直接複用 `appendDevDebugHttpLog`）：

```ts
export function appendDevDebugMcpLog(input: { tool: string; args: unknown; result?: unknown }): void {
    appendDevDebugLog('mcp', {
        label: `MCP ${input.tool}`,
        data: { tool: input.tool, args: input.args, result: input.result },
    });
}
```

### 3. 在業務代碼裡捕獲

```ts
import { appendDevDebugMcpLog } from '../utils/devDebug';

const result = await callMcpTool(tool, args);
appendDevDebugMcpLog({ tool, args, result });   // 沒勾 mcp 時是空操作，零成本
```

`appendDevDebugLog` 自帶的保護，調用方都不用操心：

- **門禁**：對應 category 沒勾就直接 return，零成本。
- **脫敏**：`data` 裡 key 名命中 `api_key / authorization / bearer / token / secret / endpoint / p256dh / auth` 的字段，值替換成 `<redacted>`（正則見 `SECRET_KEY_PATTERN`）。
- **摺疊**：默認把 `data` 裡超 10 字的長文本截成「前 10 字 + `...`」再落庫（省空間 / 隱私）——所以你新加的捕獲類導出默認也是瘦身版，要原文得復現前開「記錄完整內容」，詳見第九節。
- **容量**：全局最多最近 100 條、超 1 MB 從頭丟，不會撐爆 localStorage。
- **永不拋**：內部整個包了 try/catch，日誌失敗不影響主流程。

> 想自己看一眼，用 `console.log('[模塊名] ...')` 就行；只有當你需要把整份請求 / 響應**導出成文件發給別人排查**（或存檔、版本間對比）時，才值得加一類捕獲。

---

## 九、複製 / 下載日誌

面板底部有兩個按鈕，都調 `formatDevDebugLog()` 拿同一份 JSON（默認全部類別；傳 category 可只導一類）：

- **複製**：寫進剪貼板，丟給別人 debug。
- **下載**：存成 `devdebug-log-<分支>-<時間>.json` 文件，適合日誌大、或要存檔對比的場景。
- **清空**：只清掉已抓的日誌，**不動**總開關 / 類型勾選 / 完整內容。跟「關掉總開關」（清完之後類型 UI 也收起）和「重置」（連開關一起回默認）是三件事，挑最小動作做。

導出的 JSON 頂層帶 `exportedAt` + `build.{branch,commit}`，方便定位"到底是哪個版本、什麼時候抓的"。

### 長文本摺疊（`exposeLogDetail`）

LLM 日誌裡的聊天歷史動輒幾十條，整段塞進 localStorage 很快就把 1 MB 吃滿、存不了幾條。所以**默認在寫入時只折一處**：遞歸找對象裡 key 名等於 `messages` 且值是數組的字段（任意嵌套深度），整組替換成一句 `…共 N 項（已摺疊）`——首條通常是體積最大的 system prompt，留著沒省到多少空間，要看就開「記錄完整內容」。**其它字段（url / status / error.reason / response.outcome / 任意鍵值）一律原樣保留**——之前的版本會無差別把超過 10 字的字符串截成「前 10 字 + `...`」，結果連 `reason: "flush-not-confirmed"` 這種關鍵短字段都看不到，現在不折了。容量保護靠下面那條「100 條 / 1 MB 先到先淘汰」兜底。

- 摺疊發生在**寫入層 `appendDevDebugLog()`**——`localStorage` 裡存的就是瘦身版（messages 已折），容量限制作用在瘦身後的數據上。
- **代價**：要看完整 messages 歷史得**在復現之前**先開「記錄完整內容」（`exposeLogDetail`），之後抓的才整段存；**已抓的摺疊版無法事後還原**（原文壓根沒存過）。
- 摺疊只動每條的 `data` 裡嵌的 `messages` 數組（整組替換成一句 metadata）；`label`（含完整 url，便於定位）和 `id` / `timestamp` / `category` 保留；其它任何字段（含數組）都原樣。每條帶 `collapsed` 標記記錄抓時折沒折（expose 中途切換會讓一份日誌混著兩種）。
- 導出 JSON 只要有摺疊條目，頂層就帶一句 `note` 提示，拿到日誌的人一眼知道 messages 被截過、別當完整看。

> 摺疊是**通用**的——對所有捕獲類的 `data` 一視同仁，未來加的捕獲類自動享受，不用各自處理。當前規則只有一條：遞歸遇到 key=`messages` 的數組就整組替換成 metadata，其它字段一律原樣。

### 主動消息的 trace 是另一套（無條件記錄）

上面那套要先勾選才錄。主動消息這條鏈路另有一套 **不用勾、正式版照錄** 的記錄，落在 `localStorage` 的 `instant_push_trace_log_v1`（滾動留 400 條，刷新不丟），實現在 [`utils/instantTraceLog.ts`](../utils/instantTraceLog.ts)。Service Worker 那一側的記錄存在獨立的 `ActiveMsgSwTrace` 庫裡（SW 訪問不到 localStorage），導出時兩邊合成一份、按時間排好。

入口在 amsg2 觀察窗的 `trace` 那一行，點「導出全部」得到一個 json。因為不用提前開任何開關，**可以先復現、事後再導**。

排「通知都彈了、聊天界面半天不出字」這類問題時，看這幾個字段：

| 字段 | 在哪條記錄上 | 說明 |
|---|---|---|
| `trigger` | `runtime-flush-start` | 這趟沖刷是誰發起的。`SW通知` 是推送直達的那條；`本地巡查` 是頁面自己隔幾秒數收件箱數出來的（見下）；其餘（`回到前台` / `啟動` / `輪詢補收` / `上線補收`…）各自帶著更長的固有延遲 |
| `waitedMs` | `runtime-inbox-message` | 這條消息在收件箱裡躺了多久才輪到它。跟正文長短無關，純粹是「沒人來撈」的時間。算的是它**第一次**落到這台設備的時刻——補收把同一條重新寫一遍時會保住這個值，否則它永遠顯示「剛到」 |
| `count` / `posted` / `targets` | `notify-clients`（SW 側） | SW 喊頁面時找到幾個頁面、各自可見性、發成功幾個 |
| `portAck` / `clientsAck` | `runtime-sw-channel-probe` | 啟動時的通道體檢。兩條路分開測：port 通而 clients 不通 = SW 活著但找不到頁面 |

面板上還有一行現成的結論：**實時通道正常**（附上次收到 SW 消息的時刻），或者 **沒收到過 SW 實時通知**。後者意味著消息全靠本地巡查在撈，會慢那麼幾秒——這種狀態下功能表面上是正常的（消息照樣會到），所以只能靠主動看，等不到用戶來報。

**iOS 上這行幾乎必然顯示後者**，這是平台行為不是故障：App 不在最前台時，Service Worker 拿到的「當前有哪些頁面」名單直接是空的，存完消息喊了也沒人聽見。所以頁面不指望被喊——它自己隔幾秒數一眼本地收件箱（`sweepLocalInbox`，純本地讀、不走網絡），庫裡有貨就沖刷。`pageshow` / `focus` / 切回前台這幾個「頁面剛活過來」的時刻會額外立刻數一次。數出來是 0 就什麼都不做，**空轉不寫 trace**，否則幾秒一條就能把要看的記錄頂出緩衝區。

別把它跟 `輪詢補收` 搞混：那個是即時對話欠著回覆時每 60 秒去**雲端帳本**撈一圈（要分頁拉、還要逐條查任務狀態，全是網絡），只在欠著回覆時才存在。

---

## 十、容易踩的坑

- **改了開關行為，記得同步改面板 / category 的 `detail` 文案**，否則別人按文案理解會和實際不符。
- **總開關 `captureEnabled` 是錄製總閘**：光勾類型不會錄，得把總開關打開；關掉總開關 = 一次「錄製週期」結束 —— **立即清空已抓日誌**（清空動作落在 `writeDevDebugFlags` 數據層，任何路徑改 `captureEnabled` true → false 都觸發，不只 UI handler）、把「類型 / 記錄完整內容 / 複製 / 下載」整段 UI 收起；勾選的類型 + `exposeLogDetail` 作為下次的**配置**保留。
- **取消勾選某個捕獲類 = 只停此後抓取，不清已有日誌**（勾選是純選擇）。想清日誌走面板「重置」——它會一併把總開關關掉、清空全部勾選和日誌，比"全不勾"更徹底。
- **容量是全局共享的**（100 條 / 1 MB，各類混算）：某一類刷得很猛會把別的類擠掉，排查時注意。刪了字符串截短之後每條 response 完整保留，單條體積變大（典型 5–10 KB），1 MB 大約 100 條上下——跟 MAX_LOG_ENTRIES 同檔，先到先丟的保護仍然成立。
- **`exposeLogDetail`（記錄完整內容）必須復現前開**：它管的是"抓取時存不存完整"，不是導出時才展開。中途打開只對**之後**抓的生效，已經抓下來的摺疊版還原不了（原文沒存過）。這是用空間換的，符合"大多數時候不需要那堆歷史"的設計取捨。
- **存儲按分支隔離**：切到別的分支構建，之前的開關狀態 / 日誌不會帶過來，是預期行為。
- **master 上看不到面板是正常的**，要麼切開發分支，要麼 `VITE_SHOW_BUILD_BADGE=1`。
- **行為開關默認值一律 `false`、捕獲類默認不勾**：dev 開關是"出問題時手動打開來隔離變量"的，默認不能改變正常行為。

---

## 十一、TODO：還沒接入 devDebug 的日誌支線

`makeDebugLogger` 已經把 P1 等價的錯誤支線接進來了（safeApi 重試、ActiveMsg post-processing / saveMessage / requeue lost / flushInboxToChat、amsg multipart expired）。下面這些還沒接，價值遞減或工程量大，**單點踩坑時再換成 `log.warn(...)` 即可**（每條改 1 行）：

### P2 — 價值遞減的前端支線

| 文件 | 行 | 標籤 | 幹嘛 |
|------|----|------|------|
| `utils/activeMsgRuntime.ts` | 655 | `[ActiveMsg] restore xhs session notes failed` | xhs note 恢復失敗 |
| `utils/activeMsgRuntime.ts` | 717 | `[push:toast]` | 通知文案 |
| `utils/activeMsgRuntime.ts` | 1115 / 1117 / 1120 | `[push:memory-palace]` 幾條 | 記憶宮殿 stage / 異常 |
| `utils/activeMsgRuntime.ts` | 315 | `[flush:emotion_update] apply failed` | 情緒更新落庫失敗 |

> 接的姿勢就是：模塊頂 `const log = makeDebugLogger('amsg', '<Tag>')`（已有就複用），然後 `console.warn('[Tag] event', ...x)` 換成 `log.warn('event', ...x)`。

### SW 端（Service Worker context，工程量大）

SW 跑在自己的 context，沒法直接訪問 page 的 `localStorage` / `appendDevDebugLog`。要接 devDebug 得走一條新通道：

1. SW 端攢一份 trace ring buffer（已有 `[InstantTrace:SW]` 在 `worker/sw-keep-alive.ts`）
2. page 端解鎖面板時，向所有 SW client `postMessage({ type: 'GET_DEBUG_TRACE' })` 拉一份
3. page 端收到 SW 回包 → 寫進 devDebug 的 `amsg` 類目

涉及範圍（grep 出來的 SW 端日誌，先列著）：

| 文件 | 行 | 標籤 |
|------|----|------|
| `worker/sw-keep-alive.ts` | 213 | `[InstantTrace:SW]` |
| `worker/sw-keep-alive.ts` | 644 | `[amsg] error push` |
| `worker/sw-keep-alive.ts` | 662 | `[amsg] unknown messageKind, falling back to content` |
| `worker/sw-keep-alive.ts` | 698 / 711 | `[amsg] pushsubscriptionchange 重訂失敗` / `寫訂閱變化標記失敗` |
| `public/sw-keep-alive.js` | — | `[rei-standard-amsg-sw] ...` 系列（amsg-sw 包內的 dedupe / multipart / 通知報錯） |
| `public/sw-keep-alive.js` | — | `[InstantTrace:SW]`（構建產物裡也叫這名） |

> **建議路徑**：等真的有 SW 端 bug 需要遠端排障時再做（開發本地 SW 在 DevTools 單獨面板就能看，價值不大）。做的時候在 `utils/swVersion.ts` 旁邊新增 `utils/swTrace.ts` 包通信協議。

---

## 十二、系統調試終端裡的網絡失敗診斷（面向普通用戶）

> 注意：這一節講的是**所有用戶都看得到**的「系統調試終端」（狀態欄下方的紅色 `SYSTEM ERROR` 膠囊點開的那個），
> 不是上面十一節那個只在開發分支出現的 devDebug 面板。兩者是兩套東西，別改串了。

### 背景

瀏覽器出於安全，把下面這些完全不同的事統統報成同一句 `TypeError: Failed to fetch`，不帶任何細節：

- 梯子 / 代理把這個域名的連接掐了
- DNS 解析不到
- 瀏覽器擴展（廣告攔截、隱私盾、腳本管理器）在請求發出前就屏蔽了
- 對方**回了響應，但沒有 CORS 頭**（Cloudflare 限流頁、人機驗證頁、網關錯誤頁都長這樣）

舊版日誌只記 `URL: xxx` 一行，用戶複製出來發到群裡，信息量是零。

### 現在記什麼

`utils/networkFailureDiagnosis.ts` 負責把能補的旁證一次性補齊，`context/OSContext.tsx` 的 fetch 攔截器
在 `catch` 裡調用它：

```
URL: https://sullymeow.ccwu.cc/api/health
請求: GET · 失敗於 43ms
錯誤: TypeError: Failed to fetch
目標域名: sullymeow.ccwu.cc（跨域請求，受 CORS 約束）
本頁來源: https://xxx.pages.dev
瀏覽器聯網狀態: 在線
Resource Timing: responseStatus=429, transferSize=0 → 對方其實回了 HTTP 429，是響應被 CORS 攔掉的，不是網絡不通
初判: 請求在拿到響應頭之前就失敗了——瀏覽器沒告訴我們具體是哪一步斷的。
可能原因: 梯子/代理把這個域名的連接掐了 · DNS 解析不到 · ...
連通性複檢: no-cors 直連 sullymeow.ccwu.cc 成功 → 網絡路徑是通的，問題出在響應本身（...）
```

兩個關鍵設計：

1. **Resource Timing 的 `responseStatus`**：跨域也能讀（不受 TAO 限制）。它 > 0 就說明**對方其實回了**，
   那就是 CORS / 限流頁的事，跟網絡通不通無關——這一條直接把排查範圍砍一半。
2. **no-cors 連通性複檢**：`mode: 'no-cors'` 不做 CORS 校驗，只要網絡路徑通就會拿到 opaque 響應。
   它成功而原請求失敗 ⇒ 響應頭的問題；它也失敗 ⇒ 這台設備到這個域名是真的不通。結論異步回填到同一條日誌。

### 失敗分類別漏了 TimeoutError

線上第一版就踩到：`AbortSignal.timeout()` 拋出來的是 **`TimeoutError` / "signal timed out"**，
既不含 `abort` 字樣、也不是 `TypeError`，一度掉進 `unknown`，日誌只剩一句「不符合已知的幾種
失敗形態」。分類裡 `timeout` 必須排在 `aborted` 前面判：

- `aborted`（AbortError）= 調用方自己撤了，到此為止，不用再查；
- `timeout`（TimeoutError）= 連接**掛住不返回**，恰恰是最需要繼續查的一類，要做連通性複檢。

要不要複檢統一走 `shouldProbeReachability(kind)`，別在調用點各寫各的。

### 「失敗得多快」也是證據

`readStallHint()` 拿耗時區分兩種截然相反的形態，這是 JS 側唯一能拿到的這條線索：

- **掛幾秒到幾十秒才失敗、transferSize 0** ⇒ 握手沒人應答（黑洞）。查代理分流規則、換節點。
- **幾十毫秒就失敗** ⇒ 有人明確說不。查 DNS、擴展、防火牆。

中間地帶（0.3–5s）不硬猜，寧可不輸出——瞎猜比不說更容易把人帶偏。

### 改這塊時的坑

- **複檢必須用 `originalFetch`**（攔截器閉包裡那個未打補丁的），用打過補丁的 `window.fetch` 會讓探測自己
  失敗時再寫一條日誌，一條網絡錯誤滾成一屏。
- **複檢打的是域名根路徑，不是原地址**：原地址可能是有副作用的接口（發帖、下單），複檢不該順手觸發它；
  而 DNS / 梯子 / 防火牆 / 擴展攔的都是整個域名，打根路徑一樣測得出來。
- **同域名 30s 冷卻**：一串請求同時炸時不能對同一個域名連打探測；冷卻命中返回 `cooldown`，
  日誌裡明說「看上一條」，不能一聲不吭讓人以為漏了。
- **哪些類要複檢看 `shouldProbeReachability()`**：主動取消 / 混合內容 / 地址非法 / 離線已經有確定結論，再打一次純屬浪費。
- 判定全是純函數，迴歸守衛在 `utils/networkFailureDiagnosis.test.ts`——改文案時先看那份測試想守的是什麼。

### 用戶側自查清單

`NETWORK_SELF_CHECK_STEPS` 同時被調試終端（`components/os/StatusBar.tsx`，網絡類錯誤時摺疊展示）複用。
改文案改那一處即可，兩邊不會不同步。

## SAR 劇情與表情校對

扳手內僅在 `pnpm dev` 顯示此開關，默認關閉；開啟後臨時開放名冊全部 84 段原稿及逐句表情編輯、分支返回和 JSON 導出。關閉立即恢復真實收藏鎖定，未解鎖預覽退出；不修改星級、獎勵或收藏記錄，既有校對草稿保留。正式構建即使手動解鎖扳手也不能啟用。開關按分支隨調試標誌保存，細節見 [SAR 個人線](./sar-personal-lines.md)。
