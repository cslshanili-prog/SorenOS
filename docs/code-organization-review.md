# 代碼組織體檢報告與優化計劃

> 2026-07 由多智能體代碼分析產出：9 個維度並行深挖（頂層結構 / 巨石文件 / 狀態管理 / 類型系統 / utils 目錄 / 重複代碼 / 後端蔓延 / 測試工具鏈 / 依賴耦合）+ 1 輪完整性與數字校驗。所有數字均為倉庫實測（wc / grep / madge / tsc / vitest），經過交叉抽查修正。

## 一、總體結論

全倉 **546 個 ts/tsx 文件、1770 條內部 import 邊**。分層方向大體健康（utils→上層的逆向依賴僅 12 條、前後端之間 0 條相對導入、無跨層循環），風格事實上高度一致（0 個 tab 文件、0 處雙引號 import）。**真正的問題不是"亂"，而是"堵"**：

1. **三巨頭樞紐文件**——`types.ts`（3600 行，被約 244 個文件即 44.7% 導入）、`utils/db.ts`（3309 行，108 個導入方）、`context/OSContext.tsx`（4259 行，71 個導入方）——同時是全倉最大和改動最頻繁的文件（12 天窗口內分別被改 16/8/19 次）。任何領域的改動都要穿過它們，是多 agent 並行開 PR 工作流下合併衝突的固定爆點。
2. **零質量門禁**——CI 只 build + 部署，不跑測試、不跑 tsc、不跑 lint。當前 `tsc --noEmit` 有 **78 個錯誤**、測試套件有 **7 個用例長期掛紅**，`pnpm run build` 照常綠燈上線。
3. **utils/ 已是事實上的業務核心層**——頂層平鋪 235 個文件（148 實現 + 87 測試），至少 11 個千行級領域模塊（聊天流水線、人生模擬引擎、DB 層）被當"工具"存放，領域分目錄標準不一致。
4. **節慶驅動複製**——每逢活動整文件複製上一個活動（API 配置面板 3 份拷貝逐字重複率 88% 且已漂移）；LLM 調用樣板在 55 個文件手寫 86 處，現成的 `utils/safeApi.ts` 採用率僅約三成。
5. **local-first 名不副實的運行時 CDN 依賴**——樣式層 100% 跑在 `cdn.tailwindcss.com`（Play CDN，官方標註不適用於生產），tailwind 根本不在依賴清單裡；疊加 Google Fonts 11 個字族、unpkg KaTeX、131 處 twemoji、57 處 jsdelivr 硬編碼。倉庫已為"jsDelivr 被牆"專門造了 CdnImg 鏡像鏈，證明該風險實際發作過，但只覆蓋了素材一類。

### 做對了的事（保持）

- 分層紀律：1770 條邊裡逆向依賴只有 12 條，前後端邊界乾淨（0 條互相導入）。
- `utils/` 邏輯層有 **105 個測試文件、1181 個綠色用例**（14,086 行測試代碼）——接上 CI 立刻變成迴歸防線。
- `utils/exportGuard.ts`：備份導出時明文密鑰掃描 + 脫敏，帶 115+ 行測試。全源碼 grep 無真實密鑰入庫、無 .env 被追蹤。
- `utils/memoryPalace/`（47 文件，含域內 `types.ts` 被 20 個文件複用）和 `netlify/functions/_shared/rei.ts` 是領域目錄化與跨平台共享的現成範本。
- 倉庫衛生基本健康：.git 僅 20M，dist/ 未被追蹤。

---

## 二、問題清單

嚴重度：🔴 高（每次改動都被拖累 / 已產生實際 bug 風險）｜🟡 中（多數改動有摩擦）｜🟢 低（打磨項）

### A. 樞紐與巨石文件

| # | 問題 | 實測證據 |
|---|------|---------|
| A1 🔴 | `context/OSContext.tsx`：4259 行單 Provider | 接口 127 字段、value 93 字段的對象字面量**未包 useMemo**（全文件 0 次 useMemo）；33 useState、16 useEffect、60+ 內聯函數僅 4 個 useCallback；第 770-775 行 **1 秒間隔時鐘 setState 且每次返回新對象**，導致 70 個 `useOS()` 消費文件以 1Hz 被動全量重渲染。Provider 裡還混著 fetch monkey-patch（936-1057）、5 秒調度器、WebDAV 雲備份、exportSystem/importSystem 約 1050 行序列化邏輯 |
| A2 🔴 | `types.ts`：3600 行 / 242 個導出 / 約 244 個文件依賴 | 橫跨約 25 個業務域；~10% 的提交都要碰它。`CharacterProfile` 292 行 137 字段、`FullBackupData` 125 字段、`MessageType` 單行 27 成員 union——每加功能必改此文件。另有 37 個導出（15%）全倉零引用 |
| A3 🔴 | `utils/db.ts`：3309 行、108 個導入方 | 單個 DB 對象字面量 2826 行掛約 190 個方法覆蓋 52 個 store + 354 行 68 個版本遷移函數；且自身處於循環依賴環中（db.ts → desktopSkinBackup → blobRef → db.ts） |
| A4 🔴 | `apps/Chat.tsx`：3720 行單組件 | 65 個 useState、約 90 個內聯 handler、20 值 modalType union；向 `ChatModals` 一次傳約 78 個 props（其 Props 接口 **101 個字段**）、向 `MessageItem` 傳 47 個 |
| A5 🟡 | 其餘巨石 | `apps/MemoryPalaceApp.tsx` 5507 行（單函數 5070 行、**109 個 useState**、7 個視圖用順序 if 串聯）；`components/chat/MessageItem.tsx` 3711 行（1 文件 12 個組件，主組件內聯渲染 32 種消息卡片）；`apps/Settings.tsx` 3173 行（106 個 useState）；`hooks/useChatAI.ts` 1761 行 |

### B. 目錄結構與命名

| # | 問題 | 實測證據 |
|---|------|---------|
| B1 🔴 | `utils/` 頂層平鋪 235 個文件，業務核心被錯放 | 148 實現（49,074 行）+ 87 測試交錯平鋪；`db.ts`、`realtimeContext.ts` 2232 行、`applyAssistantPostProcessing.ts` 1887 行（聊天主鏈路）、`lifeSimEngine.ts` 1486 行（整個遊戲引擎）等 32 個 500+ 行文件都不是"工具"。分目錄標準倒掛：47 文件的 `memoryPalace/` 與 1 文件的 `like520/` 並存，而更大的音樂/TTS 集群（21 文件 4,899 行）、lifeSim（10 文件 4,147 行）、push（13 文件）、MCP（14 文件）仍平鋪 |
| B2 🟡 | 無 src/：43 個根條目源碼與雜物混排 | 前端源碼、5 套後端目錄、研究筆記 notes/、Windows .bat、6.2MB 零引用的 pics/、被遺棄的 更新日誌/ 同層；單一 tsconfig `include: **/*.ts` 把瀏覽器/Node/Cloudflare/Deno 代碼用同一套 DOM lib 一鍋端 |
| B3 🟡 | apps/ 與 components/ 邊界靠慣例 | 「聊天」一個功能橫跨 `apps/Chat.tsx` + `components/chat/`(18 文件) + `components/luckin/` + `components/mcd/` + `utils/chat*`(16 文件)；components/ 的 15 個子目錄多數是單一 app 的私有件；39 個平鋪 app 裡 27 個叫 `*App.tsx`、12 個不是；`apps/theater/` 是 VRWorld 的面板而獨立 app 卻叫 `DreamTheater.tsx` |
| B4 🟡 | 命名雙軌制造成同名混淆 | 4 個 `prompts.ts`（groupChat/vrWorld/worldHome/like520）與 5 個頂層 `*Prompts.ts` 並存；2 個 `db.ts`、2 個 `format.ts`；`context.ts`（ContextBuilder）與 `realtimeContext.ts`（天氣感知）毫無關係卻近名 |
| B5 🟡 | 零路徑別名 | tsconfig 無 paths、vite/vitest 無 alias；`../../` 導入 313 條。目前沒有 `../../../` 只是因為目錄全攤平——佈局因此被釘死，一動就斷幾百處 |
| B6 🟢 | 死代碼與死資產 | `utils/toolbox.ts`、`brainAgent.ts`、`archiveTemplate.ts` 全倉零引用（444 行）；`PhoneShell.tsx` 152-257 行整塊註釋的舊版 AppErrorBoundary；`pics/` 6.2MB、`assets/icon.png` 2.4MB 零引用；`更新日誌/` 已被遺棄（真身是被 FAQApp 引用的 `public/changelogs/`，且兩處 2026-5 已漂移） |

### C. 狀態與類型

| # | 問題 | 實測證據 |
|---|------|---------|
| C1 🔴 | 全局重渲染風暴（見 A1） | value 未 memoize + 1Hz 時鐘 + 裸箭頭函數進消費方 dep 數組（如 `Chat.tsx:1202` 的 deps 含 `addToast`），失效沿依賴鏈擴散 |
| C2 🟡 | 四條並行狀態通道無約定 | Context 之外：window CustomEvent 總線（35 文件、17+ 具名事件、`chatGenEvents.ts` 還有模塊級可變快照 hack）、localStorage 直讀寫（**101 文件 707 處**、50 個鍵、12+ 種互不相干前綴 os_/spark_/aetheros_/sully_/…）、直連 IndexedDB（51 個 apps/components 文件） |
| C3 🟡 | 類型雙軌 + 同名漂移 | `RealtimeConfig` 在 `types.ts:392` 與 `utils/realtimeContext.ts:34` 各一份且已漂移（feishuEnabled 必填 vs 可選）；`brainAgent.ts` 手工複製的 `CharacterProfile`/`Message` 與正版同名（IDE 自動導入易選錯）；utils/ 下 116 個文件另散落導出 251 個 interface，"共享進 types.ts、局部放本地"的規則事實上不存在 |
| C4 🟡 | utils→上層逆向依賴 12 條 + utils 內 10 組循環 | 典型：`chatPrompts.ts:9` 導入 `context/MusicContext`（1218 行提示詞模塊拖入 970 行 React 模塊）；`pixelHomeDecoration.ts` 導入 `apps/pixelHome/`（DB 層住在 apps 裡）；`OSContext.tsx:34` 反向導入 `hooks/useChatAI`（1761 行）只為一個非 hook 函數。madge 實測 10 組循環全在 utils/ 內部，5 組纏在 `memoryPalace/pipeline.ts` 上、1 組穿過 db.ts |

### D. 重複代碼

| # | 問題 | 實測證據 |
|---|------|---------|
| D1 🔴 | 內聯 API 配置面板 ×4 且已漂移 | Settings 原版 + Valentine/WhiteDay/Like520 各複製一份（註釋自認「復刻 Settings」）；Valentine vs WhiteDay 對應 116 行窗口 102 行逐字相同（88%），差異只有主題色和 emoji；stream 開關只有 Like520 版有——**功能修復不會傳播到其他拷貝** |
| D2 🔴 | LLM 調用樣板手寫 86 處 / 55 文件 | `chat/completions` 字符串 140 處、手寫 Bearer 頭 91 行、手工 `choices[0]` 提取 100 處；`utils/safeApi.ts` 已有 safeFetchJson/extractContent/extractJson 但採用率約三成；11 個文件還在 ad-hoc 剝 ```json 圍欄 |
| D3 🟡 | 節日組件互抄成模式 | 立繪調整面板 4 處、打字機效果至少 5 處獨立手寫；每逢新節日整文件複製上一個節日（三個節日組件合計 7649 行） |
| D4 🟡 | 同一端點按部署平台各寫一份 | bake-voice：`api/minimax/bake-voice.ts` 與 `server/bake-voice-middleware.ts` 同為 178 行、124 行逐字相同；WebDAV 代理三份且已漂移（cloudflare 版支持 Range 頭、netlify 版沒有）；MiniMax 路由映射 ×3、Fish Audio ×3、GitHub ×2 |
| D5 🟡 | luckin/mcd MCP 成套複製 | `luckinMcpClient.ts` 484 行與 `mcdMcpClient.ts` 599 行導出完全同構的 12 個符號（僅前綴不同），全文相似度 0.725；每加一個品牌要再複製約 1,100 行 |

### E. 後端與部署

| # | 問題 | 實測證據 |
|---|------|---------|
| E1 🔴 | 主代理 `worker/index.js`：3771 行單文件純 JS | 無 TS、無 wrangler.toml、靠面板粘貼部署，卻是改動最熱的後端文件（11 天 7 commits）；承載 10+ 類能力（搜索/WebDAV/GitHub/Notion/飛書/MCP/XHS Lite…）；`worker/xhs-lite/` 目錄裡只有文檔和測試，代碼已併入 index.js——目錄名指向的代碼不在目錄裡 |
| E2 🟡 | 死目標仍在倉庫且文檔當作活的 | `worker/proactive-push/` 已被前端 `FORCE_DISABLED=true` 全局停用但 README:299 仍教人部署；`netlify/functions/webdav-proxy.ts` 零調用方；`cloudflare/` 兩文件是已併入 index.js 的參考副本 |
| E3 🟡 | 後端地址配置碎成約 7 套機制 | 中心代理 localStorage key、網易雲單獨持久化、XHS 派生 + 死域名改寫補丁、instant-push 用戶自填、AMSG 走環境變量、post-office 硬編碼 `noir2.cc.cd`…… |
| E4 🟡 | 後端蔓延無地圖 | `api/`、`server/`、`netlify/`、`cloudflare/` 在 README 與 docs/ **零提及**；mcp-proxy README 鏈接的 `docs/mcp-integration.md` 不存在；.gitignore 註釋裡的腳本名也是過時的 |
| E5 🟢 | workspace 衛生 | pnpm-workspace 聲明 `worker/*` 但 6 個 worker 只有 1 個有 package.json、0 個有 tsconfig；Netlify 服務端依賴混在前端根 package.json；7 個構建產物 bundle 提交進 git 且 `public/instant-worker.deno.bundle.js` 與 worker/ 下那份字節相同的雙份入庫；瀏覽器 Service Worker（`sw-keep-alive.ts` 710 行）放在服務端 worker 目錄下 |

### F. 工具鏈與門禁

| # | 問題 | 實測證據 |
|---|------|---------|
| F1 🔴 | CI 無質量門禁 | 唯一 workflow `deploy-pages.yml` 只 install→build→部署。78 個 tsc 錯誤 + 7 個失敗測試可直接上線 |
| F2 🔴 | tsc --noEmit 現存 78 個錯誤 | 19 處 TS18048 possibly-undefined 是真實空指針隱患（`MemoryPalaceApp.tsx(2425)` "'char' is possibly 'undefined'"）；`Chat.tsx(2082)` 用 `Array.at` 但 lib 是 ES2020；MemoryPalaceApp 一個文件佔 19 個 |
| F3 🔴 | 測試帶病運行 | `utils/realtimeContext.weather.test.ts` 整文件 7 個用例全紅（mock Response 缺 headers），本地跑全量無法用"是否全綠"自檢 |
| F4 🟡 | 測試偏科 + 位置錯亂 | UI/狀態層約 127,400 行零測試（vitest include 只有 utils/worker）；utils/ 頂層還混著測 components 的組件測試（`messageItemModuleLayout.test.ts`）和倉庫級約束測試 |
| F5 🟡 | 運行時 CDN 依賴（完整性檢查補充） | `index.html:30` Tailwind Play CDN + 約 90 行內聯 tailwind.config；unpkg KaTeX；Google Fonts 11 字族；twemoji 硬編碼 URL 131 處/25 文件；jsdelivr 素材 57 處/11 文件。SW 不緩存這些——斷網/被牆時 UI 無樣式 |
| F6 🟢 | 零 lint/format 配置；依賴聲明雙軌 | 無 eslint/prettier/biome/editorconfig/husky；`index.html` importmap 釘 react@19.2.3 而 package.json 是 react ^18.2.0，兩套聲明互相矛盾 |

---

## 三、優化計劃

原則：**先加護欄，再動結構**；所有目錄/文件拆分用「別名先行 + barrel re-export 兼容」保證舊 import 不斷；按域漸進，不搞一次性大遷移。

### 階段 0 · 止血與護欄（1-2 天，全部 small 工作量，無行為變更）

1. **CI 門禁**：deploy-pages.yml 部署前插入 `pnpm vitest run` + `npx tsc --noEmit`；package.json 補 `"typecheck": "tsc --noEmit"`。現有 1181 個綠色用例立刻成為迴歸防線。
2. **清紅燈**：修 `realtimeContext.weather.test.ts`（mock Response 補 headers）；tsconfig target/lib 升 ES2022（直接消 4 個錯）；集中清 19 個 possibly-undefined，78 個 tsc 錯誤歸零後由門禁鎖住。
3. **OSContext 三步止血**（不改任何消費方）：① 時鐘 setState 前做值比較（分鐘不變不 set），1Hz 重渲染降為 1/60Hz；② value 裡的函數包 useCallback；③ value 包 useMemo。MusicContext 同理。
4. **路徑別名**：tsconfig + vite/vitest 加 `@utils/ @components/ @apps/ @context/ @/types`。這是後續一切目錄重組的前置——先別名化再挪目錄，重組 diff 只落在被挪文件自身。
5. **刪除死物**：`toolbox.ts`/`brainAgent.ts`/`archiveTemplate.ts`（444 行零引用）、PhoneShell 的 105 行註釋塊、`更新日誌/`（真身在 public/changelogs/）、零引用的 `pics/` 與 `assets/icon.png`（先 git log 確認）、`cloudflare/` 參考副本、`netlify/functions/webdav-proxy.ts`。合計瘦身約 10MB。
6. **修文檔衛生**：README:299-300 過時部署表項、mcp-proxy README 死鏈、.gitignore 過時腳本名、CLAUDE.md 文檔地圖補錄 3 份缺失文檔；proactive-push 若永久下線則刪目錄（順帶移除硬編碼 CLIENT_TOKEN），若臨時則在其 README 頂部標註停用。

### 階段 1 · 機械重構（1-2 周，低風險純移動，可分批多 PR）

7. **拆 types.ts**：按現成段落註釋邊界拆成 `types/` 下 15-20 個域文件（core/character/chat/vrworld/worldhome/lifesim/handbook/backup…），根 `types.ts` 保留 `export * from './types/...'` barrel——**303 處現有 import 零改動**。順手：刪 RealtimeConfig 副本（統一 feishuEnabled 可選性）、brainAgent 副本改派生、CharacterProfile/FullBackupData 按子系統分組成組合接口（減少多人同時追加字段的行級衝突）。
8. **拆 utils/db.ts**：按 store/領域分文件，db.ts 做 re-export 兼容；`exportXxxLocal/importXxxLocal` 一排 import 改註冊表模式（備份模塊向 db 註冊處理器），順手解開 db.ts 循環環。
9. **utils/ 目錄化**：定規則「同域 ≥3 文件或 ≥1000 行即建目錄」，把現成集群機械遷入：`utils/audio/`(21)、`utils/mcp/`(14)、`utils/push/`(13)、`utils/lifeSim/`(10)、`utils/backup/`(10)、`utils/charCreator/`(9)、`utils/chatPipeline/`（applyAssistantPostProcessing + chatPrompts + context.ts 等）。進目錄後用短名（`lifeSim/engine.ts`），頂層前綴自然消失；測試隨源文件走，組件測試移回 components/ 旁，倉庫級約束測試進 `tests/invariants/`。單獨改名兩處高危近名：`context.ts → contextBuilder.ts`、`theaterGenerator.ts → scheduleTheater.ts`。
10. **消 12 條逆向依賴**：MusicContext 的非 React 邏輯（loadMusicCfgStandalone/musicApi/parseLyric）下沉 `utils/musicCore.ts`；`evaluateEmotionBackground` 從 useChatAI 抽到 `utils/emotionEval.ts`；PixelLayoutDB 從 apps/ 移到 utils/；之後用 eslint/biome 的 import 限制規則把「utils 不依賴上層」變成可檢查約束。
11. **兩個註冊表**：`utils/storageKeys.ts`（收攏 50 個 localStorage 鍵 + 12 種前綴，加一條仿 noLookbehind 的倉庫級約束測試禁止字面量鍵）；`utils/backendEndpoints.ts`（8 套後端地址機制收攏一處，死域名改寫只在讀取層做一次）。
12. **docs/backend-map.md**：目錄→部署目標→存活狀態→前端調用入口→配置方式一張表（本報告 E 節可作底稿），README 與 CLAUDE.md 各加一行指過去。

### 階段 2 · 結構性重構（數週，按域漸進，每項獨立成 PR）

13. **拆 OSContext**：先把純邏輯搬出組件——exportSystem/importSystem 約 1050 行遷入 `utils/backup*`（已有 backupFormat.ts 等現成落點）、fetch monkey-patch / 調度器 / JSZip 加載各自成模塊，provider 只留薄掛載；再按域拆成 4-5 個子 Provider（characters&groups / theme&appearance / apiConfig / backup / toast&time），按域導出 `useTheme()/useCharacters()/useToast()` 窄 hook，消費方按需訂閱。
14. **拆聊天域**：ChatModals 的 101 props 按彈窗拆成各自持有 state 的獨立組件（modalType 已是天然判別字段）；MessageItem 的 32 種卡片渲染拆成卡片組件註冊表；展示配置類 props 合併為穩定的 layoutConfig 或 ChatSessionContext。Chat.tsx / MemoryPalaceApp（7 個 if 視圖）/ Settings（按設置域拆面板）同法逐個瘦身。
15. **統一 LLM 調用入口**：safeApi 之上補 `chatComplete(apiConfig, messages, opts)`（baseUrl 歸一化 + 鑑權 + 組裝 + extractContent/extractJson + 掛接 apiCallLog），先遷 utils/ 下 generator 類純函數（風險最低），逐步替換 55 個手寫點。
16. **終結節慶複製**：抽 `components/os/InlineApiSetup.tsx`（theme/文案作 props，Settings 與三個節日共用，stream 開關等新能力只寫一次）、`useTypewriter` hook（替 5+ 處手寫打字機）、`SpriteStage` 組件（立繪 + 調整面板 + 持久化）；「特別時光」入口改註冊表聲明，新節日從"複製 3888 行"變成"寫一份配置 + Session 組件"。
17. **品牌 MCP 工廠**：參數化 client（token key/session/前綴作配置），luckin/mcd 退化為各約 50 行配置；emoji 映射併成一張數據表。
18. **後端去重**：bake-voice/MiniMax 路由表抽運行時無關核心模塊，各平台留 10-20 行適配器（照抄 `_shared/rei.ts` 模式）；`worker/index.js` 遷成 `worker/main-proxy/src/*.ts` 按路由拆模塊，納入 build-workers.mjs 產 bundle（面板粘貼的部署體驗不變），補 wrangler.toml；xhs-lite 測試改 import 拆出的模塊。
19. **雜項歸位**：`sw-keep-alive.ts` 移出服務端 worker 目錄；apps 私有組件歸入各 app 目錄（`apps/chat/{Chat.tsx, components/, luckin/, mcd/}`），components/ 只留跨 app 複用件 + OS 殼 + `events/`；統一 `*App.tsx` 命名；`public/instant-worker.deno.bundle.js` 改由構建複製而非雙份入庫，bundle 提交策略統一（都提交則標 linguist-generated，或都 ignore + CI 構建）。

### 階段 3 · 長期（擇機）

20. **樣式層落地**：Tailwind 遷入構建管線（內聯 config → tailwind.config.ts），KaTeX CSS 與字體子集 self-host 進 public/，twemoji 收斂為碼點函數 + CdnImg 同款鏡像鏈——這是「local-first」承諾的最後一塊。
21. **風格護欄**：biome（單依賴 lint+format，初始規則與現狀零衝突：單引號、2 空格）+ .editorconfig，CI 跑 `biome ci`；`import type` 統一（consistent-type-imports 自動修復）。
22. **UI 層測試**：延續現有成功模式——巨石組件裡的純邏輯繼續抽到 utils/ 用 node 環境測；裝 jsdom + testing-library 只給拆分後的 OSContext 各 Provider 與最高頻組件補冒煙測試（vitest environmentMatchGlobs 分環境）。
23. **workspace 收編**：仍部署的 worker 各補 package.json + tsconfig（Netlify 函數的 amsg-server 依賴移過去），或收窄 workspace 聲明；解決 index.html importmap react@19 與 package.json react@18 的雙軌矛盾；給多平台目錄各配正確 lib 的 tsconfig（或 project references）。

### 排序依據

- **階段 0 是無條件先做的**：門禁缺失讓後面所有重構都在裸奔；OSContext 止血三步改動極小、收益全局。
- **拆三巨頭（7/8/13）優先於目錄美化**：它們是合併衝突與全量重編譯的根因，且 barrel 兼容讓拆分成為純機械操作。
- **複製類問題（15/16/17/18）在"下一次複製發生前"做完即回本**：每個新節日 / 新品牌 MCP / 新部署平台都是一次 1000-4000 行的複製事件。
- 已裁剪的建議：引入 zustand 等狀態庫（拆多 context + 窄 hook 已夠，重寫級方案與漸進基調衝突）、橫幅三胞胎抽象（3 文件合計 295 行，成本高於收益）、utils 局部 interface 計數（域內就近定義正是拆巨石後的終態）。
