# XHS Lite — 小紅書 Lite 後端（已併入 worker/index.js）

讓 SullyOS 角色**無瀏覽器、無隧道、無 Python、無掃碼**地瀏覽 / 搜索 / 看詳情 /
點贊 / 收藏 / 評論 / 發帖（帶圖），用戶**只需粘貼一次 cookie**。

## 它在哪、怎麼用

實現已**直接嵌入主 Worker** `worker/index.js`（即已部署的 `https://sullymeow.ccwu.cc`），
作為隔離的 `XHSLite` 模塊，對外暴露 `/api/<command>` 橋接接口，和
`scripts/xhs-bridge.mjs` 完全兼容，前端 bridge 模式直接複用。

**部署（運營方做一次）：** 像平時一樣重新部署 `worker/index.js` 即可，URL 不變。

**用戶側（不需要電腦/部署）：** SullyOS → 設置 → 實時感知 → 小紅書：
- 服務器 URL 已默認 `https://sullymeow.ccwu.cc/api`，一般無需改。
- 粘貼瀏覽器登錄 `xiaohongshu.com` 或 `rednote.com` 後的完整 cookie（含 `a1` 和
  `web_session`），點測試連接。Lite 會分別探測國內與全球后端並自動選擇，不依賴
  `gid`、`bRequestId` 等可能隨域名和灰度版本變化的字段。

cookie 存在本地，每次請求經 `X-Xhs-Cookie` 頭髮給 Worker；Worker 無狀態，
一個部署服務所有用戶。

國內小紅書和全球 RedNote 是兩套不共享會話的後端：前者請求
`edith.xiaohongshu.com`，後者請求 `webapi.rednote.com`。當前 RedNote 支持搜索、
瀏覽、詳情、點贊、收藏和評論；圖片發佈仍只對已驗證的國內後端開放。

## 原理

- `x-s` / `x-s-common` / `x-t`：純數學算法，移植自
  [Cloxl/xhshow](https://github.com/Cloxl/xhshow)（MIT），無 eval / 無 DOM。
- 圖片上傳簽名 `getSignature`：HMAC-SHA1 + SHA1（來自 Spider_XHS），用 Web Crypto 實現。
- 發帖帶圖：Worker `fetch` 圖床/CDN 圖片字節 → 算上傳簽名 → `PUT` 到小紅書 ROS →
  拿 `file_id` 發帖。

> ⚠️ `x-rap-param` 只在上游 RAP 白名單明確要求的鏈路啟用；當前“我的筆記” (`user_posted`) 和評論/回覆 (`comment/post`) 會攜帶，搜索/詳情仍保留已驗證的穩定請求形態。
> 簽名隨小紅書改版會失效，到時同步上游 xhshow 更新 `worker/index.js` 裡的 `XHSLite`。

## 驗證簽名（與 Python 原版逐字節比對）

```bash
git clone https://github.com/Cloxl/xhshow /tmp/xhshow
pip install pycryptodome
cd worker/xhs-lite/test
PYTHONPATH=/tmp/xhshow/src python3 oracle.py > vectors.json
node verify.mjs   # 期望 10 passed, 0 failed —— 直接測 worker/index.js 內嵌實現
```

| 文件 | 作用 |
|------|------|
| `worker/index.js` (XHSLite 段) | 部署用的簽名 + API 實現（唯一真源） |
| `test/oracle.py` | Python 參考 oracle（確定性向量） |
| `test/vectors.json` | 參考輸出 |
| `test/verify.mjs` | 導入 `worker/index.js` 內嵌實現並逐字節比對 |
## Spider Session v3 comments (default on)

This is an isolated, browserless experiment derived from the public protocol behavior in
`cv-cat/Spider_XHS` as of 2026-07-25. It does not replace the normal Lite detail path.
The Worker keeps no account or session database: the browser persists an opaque state containing
only an `a1` hash tag, `loadts`, counters, and a b1 seed. The raw Cookie remains in the existing
local SullyOS configuration.

Safety rules:

- The normal `/api/get-feed-detail` path never calls the protected comment endpoint.
- The experiment requires both `X-Xhs-Experiment-Ack: spider-v3-isolated-cookie` and
  `acknowledge_risk: true`.
- Each invocation makes at most one comment request. HTTP 406 opens a per-Cookie circuit breaker;
  there is no automatic retry or strategy rotation.
- The default `no-client-hints` strategy removes `sec-ch-ua*` and `x-mns`.
  `browser-hints` and `legacy-transport` are explicit one-shot A/B controls only.
- Responses use `Cache-Control: no-store`. Use a disposable test account first.

The client now enables this path by default whenever a Lite detail response has no comments.
Opening a note automatically patches its comment section; callers do not need a per-note `load_all_comments` flag or a separate API key.

Optional A/B strategy:

```js
localStorage.setItem('os_xhs_spider_v3_strategy', 'no-client-hints');
// Other explicit values: 'browser-hints', 'legacy-transport'
```

Reset the client-owned state and circuit breaker before another isolated trial:

```js
localStorage.removeItem('os_xhs_spider_v3_session');
localStorage.removeItem('os_xhs_spider_v3_circuit');
```
