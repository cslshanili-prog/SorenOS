# 自部署 SullyOS 後端 Worker

這個倉庫放的是 SullyOS 幾個後端 Worker 打好的成品代碼。你 **fork 一份、在 Cloudflare 連上它**，之後每次上游更新，你只要在 GitHub 點一下「Sync fork」，Cloudflare 就會自動重新部署——不用再複製粘貼幾百 KB 的代碼，手機上也能操作。

內容物：

| 目錄 | 是什麼 | 需要 D1 數據庫 |
|------|--------|---------------|
| `amsg/` | 主動消息 2.0：角色到點主動發消息給你 | 需要 |
| `mcp-proxy/` | MCP 工具代理：讓角色能連你自己配的 MCP 工具服務器 | 不需要 |

每個都是獨立的，只部署你要用的那個就行。

> 只部署主動消息（`amsg/`）的話，SullyOS 那邊還有一份帶截圖的完整版：
> [主動消息 2.0 · 從零開始的部署手冊](https://github.com/qegj567-cloud/SullyOS/blob/master/docs/amsg2-setup-walkthrough.md)。

---

## 一次性準備

### 1. Fork 這個倉庫

頁面右上角「Fork」。這一步之後你就有了自己的一份副本。

### 2. 建 D1 數據庫（只有 `amsg/` 需要，其餘跳過）

Cloudflare 面板 → 左側 **Storage & databases** → **D1 SQLite Database** → **Create Database**，名字隨便起（比如 `sullyos-amsg`）。

建好後會跳進這個庫的 Overview 頁，把 **Database ID** 複製下來（一串 uuid，長這樣 `3f2b1c8a-9d4e-...`）。

> 表結構不用管：SullyOS 裡點「連接」時會自動建表。

### 3. 在 Cloudflare 連上倉庫

Cloudflare 面板 → **Compute** → **Workers & Pages** → 右上角 **Create application** → 選 **Continue with GitHub**（第一次會跳去 GitHub 授權），在倉庫列表裡選中你 fork 的倉庫，點 **Next**。

往下滾到 **Set up your application**：

| 位置 | 填什麼 |
|------|--------|
| Project name | 隨便起，比如 `sullyos-amsg` |
| Build command | `sh ./deploy-prepare.sh` |
| Deploy command | 保持默認的 `npx wrangler deploy` |

再點 **Advanced settings** 展開：

| 位置 | 填什麼 |
|------|--------|
| Path | 你要部署的那個子目錄：`/amsg` 或 `/mcp-proxy` |
| API token | 下拉選 **Create new token**，名字隨便起 |
| Variable name / value | 只有 `amsg/` 需要：`D1_DATABASE_ID` = 上一步複製的 Database ID |

> Variable value 旁邊有個 **Encrypt**，**別點**——這個值要在構建階段被讀到，而且 Database ID 本身不是敏感信息。

> 代碼已經是打包好的，那條構建命令不編譯任何東西——它只做一件事：把 Database ID 填進 `wrangler.toml`。這樣你就不用去 GitHub 上編輯代碼了。

點右下角 **Deploy**。頁面會跳到構建進度，**它不會自動刷新**，看起來一直卡在 Initializing 是正常的，手動刷新就能看到真實狀態（順利的話 30 秒左右完成）。

### 4. 填密鑰

Secrets 要等**部署完**再填：Worker 頁面 → **Settings** → 最上面的 **Variables and secrets** → **+ Add**，按你部署的 Worker 加。

**`amsg/`**

| Type | 名字 | 哪來的 | 必填 |
|------|------|--------|------|
| Secret | `AMSG_MASTER_KEY` | SullyOS 設置 → 主動消息 2.0 裡能一鍵生成 | 是 |
| Secret | `VAPID_PUBLIC_KEY` | SullyOS 設置 →「推送憑據 (VAPID)」面板 | 是 |
| Secret | `VAPID_PRIVATE_KEY` | 同上 | 是 |
| Text | `VAPID_EMAIL` | 隨便一個 `mailto:你的郵箱` | 否 |
| Secret | `AMSG_SERVER_TOKEN` | 自己起一個密碼，填了就要求所有請求帶上它 | 否 |

填完點右下角 **Deploy**。

> ⚠️ VAPID 那一對**必須和 SullyOS 面板裡的是同一對**。整個站點共用一個瀏覽器推送訂閱，Worker 用別的密鑰對去籤，推送會被瀏覽器拒掉（403），表現是「一切正常但就是收不到」。

**`mcp-proxy/`** 不需要密鑰。

### 5. 把地址填回 SullyOS

Worker 的 **Overview** 頁，標題下面那個 `https://xxx.workers.dev` 就是地址，複製它，填進 SullyOS 對應的設置項裡，點「連接」。

---

## 以後怎麼更新

上游發了新版本之後：

1. 打開你 fork 的倉庫頁面
2. 點 **Sync fork** → **Update branch**
3. 完事——Cloudflare 檢測到新提交會自動重新部署

密鑰、D1 綁定、你填的 Database ID 都不會丟。

---

## 常見問題

**Sync fork 提示衝突？**
正常情況不會——你的 Database ID 和密鑰都存在 Cloudflare，不在倉庫裡，所以 fork 裡沒有你改過的文件。如果真衝突了（比如你手動編輯過），刪掉 fork 重新 fork 一遍就行，Cloudflare 那邊的連接、變量和密鑰都不受影響。

**構建失敗，日誌裡說 `D1_DATABASE_ID 是空的`？**
那個變量沒設，或者設的時候點了 Encrypt。補的位置是 Worker → **Settings** → 往下找 **Build** → **Variables**（構建階段才讀得到），不是運行時的 Secret。加完重新部署一次。

**部署成功了但 SullyOS 連不上？**
先在瀏覽器直接打開 `https://你的地址/config-check`，Worker 會自己報缺什麼（這個地址不需要密鑰，配了 `AMSG_SERVER_TOKEN` 也照樣打得開）：

- `"ok": true` → 配置齊全。連不上的話問題在地址填錯，或者 `AMSG_SERVER_TOKEN` 兩邊不一致
- `"ok": false` → 後面的 `message` 直接寫了缺哪一樣、去哪兒補
- `warnings` 裡每一條都是「能跑，但有一塊是啞的」。最常見的是 VAPID 沒配齊——任務建得成、界面全綠，到點一條都推不出去
- 整個頁面打不開 → Worker 沒起來，去 Cloudflare 的 **Deployments** 看部署日誌

SullyOS 裡點「連接並驗證」時也會先讀一次這個自檢，缺什麼會直接寫在提示裡，不用自己來開這個地址。

**找人幫忙看的時候，貼 `/debug` 的輸出**

`https://你的地址/debug` 比 `config-check` 多報庫和定時任務的狀況，一份就夠對方判斷問題在哪：

```json
{ "server": { "version": "2.6.0-next.12" },
  "config": { "ok": true, "warnings": [] },
  "storage": { "schemaReady": true, "missingColumns": [],
               "pushSubscriptionRegistered": true, "pendingTasks": 0 },
  "tick": "idle",
  "vapidPublicKey": "BDQd..." }
```

怎麼讀：

| 字段 | 不對勁的樣子 | 說明 |
|------|------|------|
| `storage.missingColumns` | 列出了幾個列名 | 換了新版本但沒重新點「連接並驗證」，定時任務會每分鐘靜默失敗。點一次就好 |
| `storage.pushSubscriptionRegistered` | `false` | 雲端沒有推送訂閱，消息發不出去。去 SullyOS 把推送開關關掉再打開 |
| `tick` | `stalled` | 有任務卡住了：到點很久一直沒人處理，或者開始發過又沒了下文。多半是定時觸發器沒配（**Settings → Trigger events**），或者 Worker 半路被 Cloudflare 掐掉 |
| `tick` | `failing` | 有任務在失敗重試。報錯原文不在這個地址裡，去 SullyOS 體檢面板的「定時任務」那一行看 |
| `vapidPublicKey` | 和 SullyOS 面板裡的對不上 | 推送會被拒（403），表現是「一切正常但收不到」|

這個地址是只讀的，也不需要密鑰，但它**不會**返回任何密鑰的值、你的用戶標識或消息內容——貼出來是安全的。

**主動消息到點了沒反應？**
`amsg/` 靠定時觸發器每分鐘檢查一次，配置裡已經寫好了（`crons = ["* * * * *"]`）。去 Worker 的 **Settings → Trigger events** 確認 Cron 那條在；不在的話通常是 Path 填錯、部署的不是 `amsg` 目錄。

**想用 wrangler 命令行而不是網頁？**

```bash
cd amsg
wrangler d1 create sullyos-amsg     # 拿 database_id 填進 wrangler.toml
wrangler secret put AMSG_MASTER_KEY # 其餘密鑰同理
wrangler deploy
```
