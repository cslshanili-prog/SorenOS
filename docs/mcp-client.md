# 通用 MCP 客戶端（用戶自配的遠程工具服務器）

> 改 MCP 接入路徑、排查「工具連不上 / 角色不調工具」前必讀。
> 這份文檔講的是**通用** MCP 客戶端；小紅書/麥當勞/瑞幸那三個寫死的客戶端不歸這裡管
> （它們分別在 `utils/xhsMcpClient.ts` / `mcdMcpClient.ts` / `luckinMcpClient.ts`）。

> 面向用戶（和用戶的 AI 助手）的自包含接入教程在 [`docs/mcp-user-guide.md`](./mcp-user-guide.md)，
> 設置裡 MCP 板塊的「?」幫助彈窗一鍵跳轉/複製的就是它——改接入行為時記得同步更新。

## 用戶視角

設置 →「MCP」→「管理」：

1. 「添加服務器」→ 填名稱和服務器 URL（如 `https://mcp.example.com/mcp`）
2. 服務器要鑑權就填 Bearer Token，或按服務商說明添加自定義請求頭（如 `XBY-APIKEY`）
3. 點「測試連接」→ 客戶端走 MCP 握手 + `tools/list`，工具清單持久化到本機
4. 打開開關 → 私聊或群聊裡就能調這些工具
5. 「適用聊天」默認通用（所有私聊和群聊）；可把服務器綁定給指定角色或群聊
   （典型場景：遊戲 MCP 只交給主持群，其他聊天看不到這批工具）

「聊天模型支持工具調用」默認開啟。若你明確知道當前模型或中轉不支持 OpenAI
function calling（例如攜帶 `tools` 就報 401），關閉它後首輪會直接走文字兼容模式，
不再先發送一次 `tools` 探測請求；即使保持開啟，遇到常見 4xx 仍會自動降級一次。

### 連不上？三種網絡路徑

瀏覽器直連遠程 MCP 服務器經常被 CORS 攔（典型症狀：測試連接時報
`Failed to fetch`）。按場景三選一：

| 路徑 | 適用 | 操作 |
|------|------|------|
| **直連**（代理 URL 留空） | 服務器 CORS 配置正確 | 什麼都不用做 |
| **本地代理** | 本地 MCP（如 xiaohongshu-mcp）、或臨時試用 | `node scripts/mcp-proxy.mjs`，代理 URL 填 `http://localhost:18061` |
| **自己的 Cloudflare Worker** | 雲端 MCP + 手機/不想在電腦跑東西 | 部署 [`worker/mcp-proxy/`](../worker/mcp-proxy/README.md) 到**自己的** CF 帳號，代理 URL 填 Worker 地址，建議設 `PROXY_KEY` 防白嫖 |

代理約定統一為 `<代理URL>?target=<url-encoded 服務器URL>`（可選 `X-Proxy-Key` 頭）。
**刻意不走中心 sfworker**：MCP 流量含用戶的 Bearer Token / 自定義鑑權頭，不應該經過項目方服務器。

## 代碼地圖

| 職責 | 文件 |
|------|------|
| 協議客戶端（握手/session/tools·list/call）+ 配置存儲 | `utils/mcpClient.ts` |
| OpenAI 工具格式轉換、跨服務器重名、系統提示塊 | `utils/mcpToolBridge.ts` |
| 設置板塊入口與幫助彈窗 | `apps/Settings.tsx` 的 `MCP_USER_GUIDE_URL` |
| MCP 管理面板 | `components/settings/McpConnectionConsole.tsx` |
| systemPrompt 注入（9d 段）+ `mcpChatActive` flag + 尾部 reminder | `utils/chatRequestPayload.ts` |
| tools 注入 + 客戶端工具循環（與瑞幸共用骨架） | `hooks/useChatAI.ts` |
| 群聊 tools 注入 + 客戶端工具循環 | `utils/groupChat/mcp.ts`、`apps/GroupChat.tsx` |
| 備份導出/導入 | `utils/db.ts`（`mcpLocal` 段）+ `types.ts` `FullBackupData.mcpLocal` |
| 本地 CORS 代理（支持 `?target=` 通用模式） | `scripts/mcp-proxy.mjs` |
| 用戶自部署 Worker 代理 | `worker/mcp-proxy/` |

## 設計要點（改之前必看）

- **兩層容錯（對標見面觀測協議）**。第一層走 function-calling：工具以 OpenAI
  `tools` 參數注入，複用瑞幸聊天點單的客戶端工具循環（`useChatAI.ts` 3.6 段），
  工具名命中 `mcpToolResolve` 映射 → 分發給對應服務器；沒命中且瑞幸模式開著 →
  走瑞幸原邏輯，兩類工具可同場。第二層兜"掉格式"（3.6b 段）：不支持 FC 的模型
  會把調用寫成正文文字（`ask_question("SullyOS")` / `ask_question: SullyOS`），
  `extractTextFakedMcpCalls` 只認已啟用服務器的真實工具名（暴露名/原名都認，
  括號/JSON/kwargs/冒號行四種形態），系統代為執行後把結果喂回去讓角色重說，
  `executedSig` 防復讀重執行。**所以不要求模型支持 function calling**，支持的
  走第一層（更穩），不支持的落第二層。
- **流式 tool_calls 必須重組**。`safeApi.ts` 的 `parseSseToCompletion` 會把
  `delta.tool_calls` 分片按 index 分組、arguments 逐片拼接——改這裡時別弄丟，
  否則開 stream 的用戶工具調用會被靜默吞掉（症狀就是"角色說要查但沒動靜"）。
- **工具清單讀持久化結果，不在聊天路徑髮網絡請求**。`tools/list` 只在設置裡
  點「測試連接」時跑；服務器更新了工具需要用戶重新點一次。
- **暴露名 ≠ 真實工具名**。OpenAI 工具名只許 `[A-Za-z0-9_-]{1,64}`，MCP 工具
  名可能帶點號；跨服務器還會重名。`buildMcpOpenAITools()` 返回
  `resolve: Map<暴露名, {server, toolName}>`，執行時必須經它換回真實名。
- **本地聊天路徑的 MCP 模式本輪禁 thinking**
  （`toolModeActive`，Gemini 系 "thinking + tools" 同發會 400）——與
  瑞幸/麥當勞既有約束一致，設置卡片裡已向用戶說明。
- **即時對話路徑下 MCP 由 amsg worker 雲端執行**：主動消息 2.0 的即時對話（見
  `plans/amsg2-instant-chat-contract.md`）刻意不把 MCP 排除在外——worker fire 時自己解析 `tool_config`、直連用戶配置的 MCP 服務器，
  工具說明塊與憑據都由 worker 側統一供給（客戶端這次 POST 順手把 `tool_config` 傳上去）。
- **session 失效自動重連一次**：`tools/call` 遇 HTTP 400/404 會重握手重試
  （服務器重啟後 `Mcp-Session-Id` 作廢是常態）。
- **協議版本必須真實協商**：initialize 以 `2025-11-25` 發起，接受服務端回落到
  `2025-06-18` / `2025-03-26`；協商結果寫進會話，之後通知、`tools/list`、
  `tools/call` 全部攜帶 `MCP-Protocol-Version`。`2024-11-05` 是舊 HTTP+SSE
  雙端點，不能再用單端點客戶端冒充支持；`2026-07-28` 是新的無握手生命週期，
  也不能只換版本號冒充支持。
- **配置改動要 `resetMcpSession`**：URL/token/代理任一變了舊 session 就不能用，
  設置卡片的 `update()` 已處理。
- **聊天綁定在 `getEnabledMcpServers(charId)` 一處收口**。歷史字段名仍叫 `charIds`，
  但其中可以存角色 ID 或群聊 ID；空/缺省 = 通用，非空只對綁定聊天可見。
  私聊傳 `char.id`，群聊傳 `group.id`；**ID 缺省時綁定服務器一律不可見**
  （防止無聊天上下文的調用點洩漏專屬工具）。

## 排查「角色把工具調用輸出成文字」

1. 先確認是不是流式吞掉了 tool_calls（上面第二條）——開 DevTools 看響應裡
   有沒有 `delta.tool_calls`，有但界面沒反應就是重組層出問題。
2. 模型不支持 FC / 中轉剝了 `tools` 參數 → 屬第二層容錯的正常工作範圍，
   假調用會被代執行 + 二次生成，用戶最終看不到亂碼。若還是漏，通常是模型
   編了不存在的工具名（只認已啟用服務器的真實工具名，不認幻覺名）。

## 已知邊界

- 只支持 Streamable HTTP（含 SSE 響應體解析）；不支持舊版 HTTP+SSE 雙端點
  傳輸，也不支持本地 stdio 服務器（那種請套 mcp-proxy 或自行起 HTTP 端）。
- 只用了 MCP 的 tools 能力；resources / prompts / OAuth 授權流未實現
  （靜態 Bearer Token 與自定義 Header 均支持；OAuth 登錄流仍未實現）。
- 當前完整支持的是 MCP handshake era 的 Streamable HTTP（2025-03-26 至
  2025-11-25）。2026-07-28 modern era 的 `server/discover` / 每請求 `_meta`
  尚未實現，遇到 modern-only 服務器會給出明確版本錯誤，不會靜默錯連。
- 工具結果回填上限 20000 字符（`formatMcpToolResult`，正常使用等於不截斷，
  只防病態超長結果炸上下文；被截斷時會標註全文長度）。瑞幸自己的工具仍是 1500。

## amsg2 後台路徑

主動消息 2.0 的 worker 到點調 MCP，走與前台不同的一條鏈：

- **配置**：`mcpClient.collectMcpFireServers()` 把 enabled + 已發現工具 + 公網
  地址的服務器（含 token/customHeaders，剝代理字段）與「聊天模型支持工具調用」
  開關一起，作為 `tool_config.mcpServers` / `mcpUseNativeTools` 隨 client_state
  加密通道上雲（`activeMsgClient.buildToolConfigEntry` 是三條上傳路徑的唯一咽喉）。
  被服務端標成 destructive 的工具會從後台清單剔除，因為無人值守環境不能彈確認窗。
- **提示詞與 tools**：worker 在 onBeforeFire 用 `mcpFireCore.buildMcpFireBlock` /
  `buildMcpFireTools` 從 tool_config 現場生成——與憑據同源，不經過 fire_pack，
  沒有陳舊窗口。amsg-server 帶 `agentic-fire-tools` feature 的版本起，fire 循環
  透傳 tools 請求參數。
- **調用識別（與前台同構的兩層）**：native tool_calls 優先；沒有 native 時用
  前台「兼容模式」同一個解析器（`extractTextFakedMcpCalls`，`alsoMatchPrefix`
  選項認帶前綴寫法）從正文摳 `tool_name({...})`。統一 `mcp__` 前綴路由
  （`MCP_FIRE_NAME_PREFIX`，名映射預算 `MCP_FIRE_NAME_BUDGET` 由它算出）。
- **執行**：`executeToolCalls` 按前綴分流到 `runMcpFireTool`，worker 直連
  `server.url`（服務端 fetch 無 CORS）；單次調用 25s、單次 fire 內共享 120s
  總預算，預算盡了早退回喂而不是拖到輪次上限整條重跑。
- 純邏輯都在 `utils/mcpFireCore.ts`（環境無關葉子，進 worker bundle，禁加
  瀏覽器依賴——有守衛測試掃 import）；瀏覽器側 mcpClient/mcpToolBridge 委託
  同一份實現。
- **版本歪斜可見**：capabilities 的 `agentic-fire-tools` + 設置頁版本門檻，
  老 worker 不會靜默吞掉 MCP 配置。

迴歸守衛：`scripts/amsg2-e2e-harness.mjs` S8/S8b（mock MCP 服務器端到端）+
`worker/amsg/src/agentic.test.ts`、`index.test.ts`、`utils/mcpFireCore.test.ts`。
