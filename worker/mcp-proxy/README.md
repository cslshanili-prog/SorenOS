# MCP CORS 代理（用戶自部署）

瀏覽器直連遠程 MCP 服務器時，如果對方沒配好 CORS（最常見：缺
`Access-Control-Expose-Headers: Mcp-Session-Id`），MCP 握手會失敗。
這個 Worker 部署到**你自己的 Cloudflare 帳號**，做透明轉發並補上 CORS 頭。

> 三種接入方式任選其一，詳見 [`docs/mcp-integration.md`](../../docs/mcp-integration.md)：
> 1. **直連**：MCP 服務器 CORS 配置正確時，代理 URL 留空即可，什麼都不用部署
> 2. **本地代理**：`node scripts/mcp-proxy.mjs`，適合本地 MCP（如 xiaohongshu-mcp）
> 3. **自己的 Cloudflare Worker**：就是本目錄，適合雲端 MCP + 不想在電腦上跑東西

## 部署

方式 A（無需裝任何工具）：Cloudflare Dashboard → Workers & Pages → Create →
Quick Edit，把 `worker.js` 內容粘貼進去 → Deploy。

方式 B（命令行）：

```bash
cd worker/mcp-proxy
wrangler deploy
```

部署完會得到一個地址，形如 `https://sullyos-mcp-proxy.<你的子域>.workers.dev`。

## 防白嫖（強烈建議）

Worker 地址一旦洩露，任何人都能用它中轉流量。設置一個密鑰：

```bash
wrangler secret put PROXY_KEY   # 或在 Dashboard 的 Settings → Variables 里加
```

然後在 SullyOS 設置裡該 MCP 服務器的「代理密鑰」填同一個值。

## 在 SullyOS 裡使用

設置 → MCP 服務器 → 「代理 URL」填你的 Worker 地址（「代理密鑰」按需填寫）。
前端會自動把請求包裝成 `<代理URL>?target=<MCP服務器URL>` 轉發。

## 請求協議

- `POST/GET/DELETE <worker>/?target=<url-encoded MCP URL>`
- 透傳頭：`Content-Type` / `Accept` / `Authorization` / `Mcp-Session-Id` /
  `MCP-Protocol-Version` / `Last-Event-ID`，以及 SullyOS MCP 設置中填寫的自定義請求頭
- 鑑權頭：`X-Proxy-Key`（設置了 `PROXY_KEY` 才校驗）
- 拒絕內網/本機目標地址（SSRF 防護）
- SSE 流式響應原樣透傳
