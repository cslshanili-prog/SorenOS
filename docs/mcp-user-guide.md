# SullyOS 接入 MCP 工具服務器 · 用戶教程

> 這份教程寫給兩類讀者：**想給角色外接工具的用戶**，以及**被用戶拉來幫忙的 AI 助手**。
> 它是自包含的——AI 助手讀完本文即可帶用戶走完全程，不需要讀 SullyOS 源碼。
>
> 如果你是 AI 助手：請先問清用戶兩件事——①想接什麼工具（現成服務還是某個開源項目）；
> ②服務器打算跑在哪（雲端 / 用戶自己的電腦 / 電腦+內網穿透）。然後按「三條路線」對號入座。

## 一、背景：SullyOS 的 MCP 客戶端長什麼樣

SullyOS 的核心前端可以靜態部署（通常是 GitHub Pages），沒有強制所有 MCP 請求
經過項目方中央代理：

- 所有 MCP 請求由**用戶的瀏覽器直接發出**，配置（URL/Token/自定義請求頭）只存用戶本機，不經過任何中間服務器。
- 好處是隱私自由；代價是 **MCP 服務器需要用戶自己準備**，且要過瀏覽器這一關（CORS、混合內容）。

### 客戶端硬性約束（AI 助手請務必記住這幾條）

| 約束 | 說明 |
|------|------|
| 傳輸協議 | 支持 handshake era 的 **Streamable HTTP**（MCP 2025-03-26 / 2025-06-18 / 2025-11-25，單端點 POST，含 SSE 響應體）。**不支持** stdio、舊版 HTTP+SSE 雙端點，也暫不支持 2026-07-28 modern-only 生命週期 |
| 鑑權 | 支持**靜態 Bearer Token**，也支持 Key-Value 自定義請求頭（如 `X-API-Key`、`XBY-APIKEY`）。**沒有實現 OAuth 登錄流程**——OAuth-only 服務仍需手動申請長期 token/key，或關閉 OAuth |
| CORS | 瀏覽器直連要求服務器返回正確 CORS 頭，最容易漏的是 `Access-Control-Expose-Headers: Mcp-Session-Id`（漏了會靜默握手失敗）。服務器改不了就走代理（見第四節） |
| 混合內容 | SullyOS 部署在 HTTPS 時，服務器 URL 必須是 `https://`；**唯一例外是 `http://localhost`**（瀏覽器豁免） |
| 工具結果 | 回填給角色的單次結果上限 20000 字符，超長會截斷並標註。超長內容建議服務器端分頁 |
| 工具清單 | 只在「測試連接」時拉取並持久化。服務器更新了工具，需要回設置**重新點一次測試連接** |
| 聊天綁定 | 每個服務器可選「通用（所有私聊和群聊）」或綁定指定角色/群聊。**通用服務器所有聊天共用**——接記憶類或遊戲類服務器時，按數據隔離需要綁定到具體角色或群聊 |

## 二、三條接入路線（按用戶情況選一條）

### 路線 1：用現成的雲端 MCP 服務（最簡單）

對方給你一個公網 `https://.../mcp` 地址（可能還有 API Key / Token）。

1. 直接跳到第三節「在 SullyOS 裡配置」。
2. 挑選服務時的篩選條件：標註 **remote / Streamable HTTP**、鑑權是**無鑑權或 API key**（OAuth 的接不了）。
3. 去哪找：官方註冊中心 `registry.modelcontextprotocol.io`、官方列表 `github.com/modelcontextprotocol/servers`、社區目錄 mcp.so / Smithery / Glama / PulseMCP。**注意**：目錄裡大部分是 stdio 本地服務器（`npx`/`uvx` 啟動那種），SullyOS 接不了，認準 remote。

### 路線 2：部署在用戶自己的電腦上

適合開源 MCP 項目（如記憶庫類）。數據在自己硬盤上，不花錢。

1. 按該項目的文檔在本機跑起來，**確認它監聽的是 Streamable HTTP**（很多項目默認 stdio，需要配置切換，常見開關如 `transport: streamable-http` 或環境變量）。
2. 該項目若默認開 OAuth，找它的關閉開關（通常是 `xxx_REQUIRE_AUTH=false` 之類），本機使用風險可控。
3. 服務器 URL 填 `http://localhost:端口/mcp`——**只在這台電腦的瀏覽器裡有效**。
4. 想在手機上也能用 → 加內網穿透（推薦 Cloudflare Tunnel：免費、自帶 HTTPS 域名）。穿透後 URL 變成 `https://你的域名/mcp`，全設備可用；但此時端點暴露公網，見第六節安全注意。
5. Windows 用戶常見坑：PowerShell 5.1 不認 `&&`（分開執行或用 `;`）；Python 項目讀中文文件報 GBK 錯，設環境變量 `PYTHONUTF8=1`。

### 路線 3：自己部署到雲上

適合想全平台隨時用、且不想家裡電腦常開的用戶。VPS / Cloudflare Workers / Zeabur / Render 均可。

- 有狀態的服務（如記憶庫）**必須掛持久磁盤/Volume**，否則重啟數據全丟。
- 自己寫/自己部署的服務器，在服務端配好 CORS 就能免代理直連，需要這幾個響應頭（`OPTIONS` 預檢返回 204 並帶同樣的頭）：

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, GET, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Accept, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, XBY-APIKEY
Access-Control-Expose-Headers: Mcp-Session-Id
```

## 三、在 SullyOS 裡配置（所有路線殊途同歸）

1. 打開 SullyOS → **設置** → 找到「**MCP**」→ 點「**管理**」
2. 「添加服務器」→ 填：
   - **名稱**：隨意，如 `Ombre Brain`
   - **服務器 URL**：如 `https://mcp.example.com/mcp` 或 `http://localhost:18001/mcp`
   - **Bearer Token**：服務器要求 `Authorization: Bearer ...` 時填寫，否則留空
   - **自定義請求頭**：服務商要求 `X-API-Key`、`XBY-APIKEY` 等非 Bearer 鑑權時，點「添加請求頭」填寫名稱和值
   - **代理 URL**：留空 = 直連；被 CORS 攔了才填（見第四節）
3. 點「**測試並讀取工具**」→ 成功會顯示服務端名稱、協商版本與工具數量
4. **打開該服務器的開關**（不開開關角色用不了）
5. 可選：「**適用聊天**」默認全部聊天；可綁定指定角色或群聊
6. 驗收：在私聊或已綁定的群聊裡讓角色用一下工具，界面會短暫顯示「正在調用 MCP 工具：xxx」

補充開關「原生 tools 工具調用」：`tools / function calling` 是聊天模型的一項能力，讓角色用標準格式告訴 API“要調用哪個工具、傳什麼參數”，SullyOS 才能真正執行，而不是讓模型把調用寫成普通聊天文字。默認開啟，也是推薦方式，調用更穩定、參數更可靠。

不知道自己的模型或中轉是否支持時，請詢問你所使用的 API 負責人或售賣方，明確確認是否支持 `tools / function calling（函數調用）`。拿不準時保持開啟；只有對方明確說不支持，或帶 `tools` 參數會報錯時才關閉，退回文字兼容模式。不關閉也有自動降級，只是會多一次試探請求。

## 四、連不上？CORS 代理二選一

「測試連接」報 `Failed to fetch`，基本都是服務器 CORS 沒配好且你改不了它。SullyOS 倉庫自帶兩個代理：

| 方式 | 適合 | 步驟 |
|------|------|------|
| **本地代理** | 本地 MCP、或臨時試用 | 在 SullyOS 倉庫目錄跑 `node scripts/mcp-proxy.mjs`，「代理 URL」填 `http://localhost:18061` |
| **自部署 Cloudflare Worker** | 雲端 MCP + 手機使用 | 把倉庫 `worker/mcp-proxy/worker.js` 粘到自己 CF 帳號（Dashboard → Workers → Create → 粘貼 → Deploy），「代理 URL」填 Worker 地址；**建議設 `PROXY_KEY`** 環境變量防白嫖，同時在 SullyOS「代理密鑰」裡填同一個值 |

代理只做透明轉發 + 補 CORS 頭，約定為 `<代理URL>?target=<服務器URL>`。刻意不提供公共代理：MCP 流量含你的 Token，不應經過項目方服務器。

## 五、排查速查表

| 症狀 | 原因與解法 |
|------|-----------|
| 測試連接 `Failed to fetch` | CORS 攔截 → 配代理（第四節）；或 URL 寫錯/服務器沒起 |
| 測試連接 401/403/500 | 核對服務商要求的鑑權方式：Bearer 填 Token；`X-API-Key` / `XBY-APIKEY` 等填自定義請求頭；OAuth-only 需找長期 token/key 或關閉 OAuth |
| HTTPS 站點填 `http://` 地址被拒 | 混合內容攔截 → 換 https（穿透/上雲），`http://localhost` 除外 |
| 角色嘴上說用工具但沒動靜 | 該服務器開關沒開；或模型不支持 function calling → 關「聊天模型支持工具調用」 |
| 角色把 `工具名(參數)` 打在聊天裡 | 正常兜底行為，系統會代為執行再讓角色重說；頻繁出現說明模型較弱，換模型更穩 |
| 服務器加了新工具但角色不知道 | 回設置重新點「測試連接」刷新工具清單 |
| 服務器重啟後第一次調用失敗 | session 失效，客戶端會自動重連一次，一般無感；連續失敗就重新測試連接 |
| 提示協議版本不兼容 | 確認服務提供的是 Streamable HTTP 2025-03-26～2025-11-25；舊雙端點和 2026-07-28 modern-only 不能混用 |

## 六、安全注意

- **Token 與自定義請求頭只存你本機**，但走代理時流量會經過你自己配的代理——所以代理必須是你自己部署的。
- **無鑑權端點別裸奔公網**：穿透/上雲後若服務器關了鑑權，任何拿到 URL 的人都能調你的工具（讀寫你的記憶）。至少用不易猜的域名並別外傳；講究的在前面擋一層反代校驗 `Authorization` 頭（SullyOS 填的 Bearer Token 會原樣透傳，正好用上）。
- **有真實副作用的工具**（發佈/下單/刪除）：服務端正確提供 `destructiveHint` 時，SullyOS 會自動彈出確認窗；普通工具不額外詢問。提示詞不是權限系統，高危工具仍需謹慎接入。
- 通用服務器會被所有私聊和群聊共用；需要隔離時，把服務器綁定給指定角色或群聊（配置裡的「適用聊天」）。

## 七、主動消息裡也能用

配好的 MCP 工具在定時主動消息（主動消息 2.0）裡同樣可用：角色到點想用工具時，
由你部署的 amsg worker 直接連你的 MCP 服務器，不需要瀏覽器開著。

需要滿足的條件：

- amsg worker 是較新的部署（設置頁會在版本過舊時提示重新部署）；
- 服務器地址是公網可訪問的（`localhost` 或局域網地址只有你的瀏覽器夠得著，
  worker 連不上，這類服務器不會帶進主動消息）；
- 服務器在設置裡處於啟用狀態、且已「發現工具」。

服務端明確標為 destructive 的工具不會進入後台工具清單，因為無人值守環境無法確認。

代理設置對主動消息不生效：worker 在服務端直連你填的服務器地址，沒有瀏覽器的
跨域限制，所以不需要代理。綁定聊天的設置照常生效——綁定了角色的服務器只有
那個角色的主動消息能用。「聊天模型支持工具調用」開關也照常生效：關掉後主動
消息同樣改用正文方式調工具，適合拒絕 tools 參數的中轉。

Token 會隨配置同步到你自己的 amsg worker（走端到端加密通道，與 Notion / 飛書
憑據同一存放方式），不經過任何第三方服務器。改動 MCP 配置後會自動同步；
下一次到點的主動消息用的就是新配置。

單次工具調用限時 25 秒、一次主動消息內全部調用共享 120 秒預算——預算用完
角色會用手上已有的信息收尾，不會一直等。

---

*開發者視角的實現細節（兩層容錯、工具循環、代碼地圖）見 [`docs/mcp-client.md`](./mcp-client.md)。*
