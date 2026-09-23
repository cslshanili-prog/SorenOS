# 網易雲音樂後端 · 多上游擴容指南

1000 用戶量級下，單一 Vercel 部署會卡在三個地方：
1. **Vercel Hobby 的 GB-Hours 配額**（約 72 萬次請求/月會打滿）
2. **Vercel Hobby 條款禁止商用**（1000 用戶可能被判商用）
3. **NetEase 風控**（單 IP 請求過多會被封 `-460/-7`）

這份教程帶你把後端擴容到 **2~3 個上游**，讓 Worker 隨機挑選 + 自動容災。

---

## 效果

做完之後你會有：

```
📱 前端
 │
 ▼
☁️ Cloudflare Worker (帶邊緣緩存)
 │ 隨機挑 + 容災
 ├──▶ 🟢 Vercel 主站 (原有)
 ├──▶ 🦕 Deno Deploy (免費 100萬 req/天)        ← 本教程新增
 └──▶ 🟢 Vercel 二站 (可選 · 雙倍配額)           ← 本教程新增
```

**單項收益**：
- 邊緣緩存：Vercel 調用量 ↓ **50~70%**
- Deno Deploy：另一條完全獨立的國外線路 + 獨立 IP
- 多 Vercel：總配額 ×2

---

## 方案 A · 加 Deno Deploy（強烈推薦，5 分鐘）

Deno Deploy 是 Deno 官方託管，免費版就有 **100 萬 req/天**，比 Vercel 爽 10 倍。

### 1. Fork api-enhanced

打開 <https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced>，右上角 **Fork**。

### 2. 確認倉庫裡有 Deno 入口

在 Fork 後的倉庫裡應該能找到 `app.mjs` 或 `server.mjs`。如果沒有 Deno 專用入口，用下面這段代碼創建一個文件 `deno.ts`：

```ts
// deno.ts — Deno Deploy 專用入口
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { serveNeteaseApi } from "./app.js";

serve(async (req) => {
  return await serveNeteaseApi(req);
});
```

> 💡 如果上面這段看不懂，跳過方案 A，直接看下面的**方案 B（第二個 Vercel）**，更簡單。

### 3. 去 Deno Deploy 部署

1. 打開 <https://dash.deno.com/>（用 GitHub 登錄）
2. 右上角 **New Project**
3. 選擇 **Deploy from GitHub**，找到你剛 Fork 的 `api-enhanced`
4. **Entry point**：輸入 `app.mjs`（或你創建的 `deno.ts`）
5. 點 **Deploy** ✅

拿到類似 `https://你的項目名-xxx.deno.dev` 的 URL。

### 4. 測試是否能用

在瀏覽器打開：
```
https://你的項目名-xxx.deno.dev/cloudsearch?keywords=晴天&limit=3
```

能返回一段包含"晴天"、"周杰倫"字樣的 JSON 就是成功了 🎉

### 5. 加到 Worker 的多上游數組

編輯 `worker/index.js` 大約第 575 行：

```js
const NETEASE_UPSTREAMS = [
  "https://api-enhanced-ochre-kappa.vercel.app",
  "https://你的項目名-xxx.deno.dev",  // ← 把這行取消註釋 + 粘貼你的 URL
];
```

重新部署 Worker（Cloudflare 控制台 → Edit Code → Deploy）。

---

## 方案 B · 再開一個 Vercel 部署（3 分鐘，最簡單）

如果 Deno 那套搞不定，退而求其次：**再部署一份 api-enhanced 到 Vercel**。配額立刻翻倍。

建議用**另一個 GitHub 帳號**登錄 Vercel 做二部署，這樣兩個 Vercel 的配額是分別計費的。但同一個帳號也能部 —— 只是總配額不變，僅起到 IP 分流的作用（對抗 NetEase 風控依然有效）。

### 步驟

1. 登錄 Vercel（可以開小號）
2. 點 **New Project** → 選擇 **api-enhanced** 倉庫
3. 一鍵 Deploy（不用改任何設置）
4. 拿到 `https://api-enhanced-mirror-xxx.vercel.app` 這樣的 URL

### 加到 Worker

```js
const NETEASE_UPSTREAMS = [
  "https://api-enhanced-ochre-kappa.vercel.app",
  "https://api-enhanced-mirror-xxx.vercel.app",  // ← 粘貼你的 URL
];
```

重新部署 Worker。

---

## 方案 C · 自己的 VPS（最穩，月花 $3-5）

如果願意花點小錢，買一台 VPS 自己跑 api-enhanced：

- **Oracle Cloud Free Tier** — 永久免費 (2 台 AMD/4 台 ARM)
- **Hetzner CX11** — €4/月 起
- **Bandwagon Host** — $18/年起

用 Docker 一把梭：
```bash
docker run -d --restart=always -p 3000:3000 --name netease-api \
  binaryify/netease_cloud_music_api:latest
```

然後給域名配反代（或直接用 `http://你的VPS-IP:3000`），加進 `NETEASE_UPSTREAMS`。

---

## 怎麼驗證緩存生效

瀏覽器 F12 → Network，找一個 `lyric` 或 `search` 請求，看 Response Headers：

- **第一次請求**：`X-Sully-Cache: MISS` + `X-Sully-Upstream: xxx.vercel.app`
- **第二次相同請求**：`X-Sully-Cache: HIT`（沒有 `X-Sully-Upstream`，因為沒打上游）

如果第二次還是 MISS，可能是：
- 請求帶了 cookie（比如 `song/url` 會按 VIP 分桶）
- 查詢參數裡有動態值（比如每次不同的 timestamp）

---

## 緩存 TTL 參考

| 接口 | 緩存時長 | 理由 |
|---|---|---|
| `lyric` | 30 天 | 歌詞幾乎永遠不變 |
| `song/detail`、`album`、`artists` | 1 小時 | 元數據穩定 |
| `search`、`toplist`、`banner` | 10~30 分 | 結果更新慢 |
| `playlist/detail`、`playlist/track/all` | 10 分 | 歌單偶爾更新 |
| `song/url`、`mv/url` | 3 分 | 簽名 URL 5 分過期 |
| `user/*`、`likelist`、`login/*` | **不緩存** | 用戶私有數據 |
| `personal_fm`、`recommend/songs` | **不緩存** | 個性化每次不同 |

要改 TTL 直接改 `worker/index.js` 裡 `NETEASE_CACHE_TTL` 對象就行。

---

## 監控 & 觀察

### Cloudflare Worker

<https://dash.cloudflare.com/> → Workers & Pages → 你的 worker → **Metrics** 標籤。重點看：
- **Requests** / 天 —— 免費上限 **100,000**
- **CPU Time** —— 免費上限 10ms/請求

### Vercel

<https://vercel.com/dashboard> → 進入項目 → **Usage** 標籤。重點看：
- **Serverless Function Execution** —— Hobby 上限 **100 GB-Hours/月**
- **Edge Middleware Invocations**
- **Bandwidth** —— Hobby 上限 **100 GB/月**

接近 80% 就該開第二個上游了。

### 網易風控告警

Worker 的 `fetchFromAnyUpstream` 已經自動識別 `code=-460/-7` 並切換上游。但如果**所有上游都被風控**，前端會收到：

```json
{ "error": "netease upstream fetch failed (all sources)",
  "detail": "xxx.vercel.app risk-control | yyy.deno.dev risk-control",
  "tried": 2 }
```

出現這個就說明 NetEase 盯上你了，需要：
- 再加一個新上游（新 IP）
- 臨時換一下 `NETEASE_REAL_IP` 常量裡的 IP
- 給 Worker 加速率限制（防止單用戶刷爆）

---

## 終極版建議（>1000 用戶）

1. **Vercel 主站**（原有，2~3 倍 Pro 擴容 $20/月）
2. **Deno Deploy**（免費，國外流量主力）
3. **VPS 一台**（Oracle 免費 / Hetzner €4）承擔國內慢線路
4. Worker 里加**按 cookie 限速**（1000 user 每人每秒不超過 2 req）
5. 監控 Vercel Usage，每月 1 號看一次

做完這些，百級到萬級用戶都能穩。
