# amsg2 自部署全流程實測 · 問題清單

時間：2026-07-26 00:20 – 01:45
環境：全新 D1 + 全新 Worker（Git 導入方式）+ 全新 VAPID，前端 `feat/amsg2-multitask-gate@3b4af16`，sw 1.15.1

跑通的部分見 [`docs/amsg2-setup-walkthrough.md`](../docs/amsg2-setup-walkthrough.md)。下面只列問題。

---

## 一、會真的卡住用戶的

### 1. 「共享密鑰 · 隨機」生成的值拿不到（已修）

`components/settings/ActiveMsgGlobalSettingsModal.tsx` 的 `handleGenerateServerToken`：
生成後只寫進一個 `type="password"` 的輸入框，既沒複製到剪貼板，也沒有顯示/複製按鈕。
Toast 卻寫著「記得把同樣的值填進 Worker 環境變量 AMSG_SERVER_TOKEN」——用戶根本讀不到那個值，
這一步走不下去（旁邊的 `AMSG_MASTER_KEY` 是「生成並複製」+ 明文回顯，兩者不一致）。

已按 master key 的寫法改成：生成 → 寫剪貼板 → 下方明文回顯（剪貼板失敗也能手抄）。

### 2. App 內「部署 Worker」指引還是舊的粘貼流程（已修）

同一個 Modal 裡的「部署 Worker（第一次用先做這個）」寫的是：

> 點下面「複製 Worker 代碼」，去 CF 後台 Create → Worker 建一個空 Worker，進 Edit code 全選粘貼覆蓋…
> Settings → Bindings 加一個 D1 database，變量名必須是 DB…
> Settings → Trigger Events 加 Cron Trigger：`* * * * *`…

而現在推的是 fork `sullyos-workers` + Cloudflare 連 Git 的流程，D1 binding 和 cron 都由倉庫裡的
`wrangler.toml` 自動帶上，用戶按 App 裡的指引反而會多做兩步、還可能建出配置不一致的 Worker。
兩處說法要統一。

已把這一節改成 fork 流程（含 Fork 倉庫 / 圖文教程 / CF 面板三個跳轉），粘貼那套連同
「複製 Worker 代碼」按鈕降級成摺疊區「沒有 GitHub 帳號？手動粘貼部署」。「Worker 版本過舊」
的提示也改成先說 Sync fork。

---

## 二、會讓人誤判「失敗了」的顯示問題

### 3. 新建/編輯任務後，列表立刻誤標「⚠ 遠端不存在（可能已發送或在別處取消）」（已修）

復現：任意角色 → ＋ → 主動消息 2.0 → 新建任務 → 提交成功後，新任務卡片下方立刻出現橙色告警。
關掉面板重開就消失。原因是列表拿「創建之前抓的遠端快照」去比對剛創建的本地任務。
每次新建都會出現，第一次用的人會以為排程失敗。

修法：那份快照現在當底帳維護——排程接口回 success 就是「這條在遠端存在」的確證，
直接記進去（`applyRemoteTaskDelta`），取消成功則出帳，不用重新拉全量。判定挪進
`isRemoteMissingTask`，迴歸測試在 `utils/amsg2Tasks.test.ts`。

### 4. 取消一個已經觸發過的一次性任務 → 「遠端取消失敗，可重試」（已修）

一次性任務發出去以後遠端行會被刪掉，此時點「取消」，`DELETE /cancel-message` 找不到目標，
前端直接標成紅色的失敗並提示重試，但其實沒有任何東西需要重試。
應該把「遠端已不存在」當成取消成功（或者對已到點的一次性任務乾脆不顯示「取消」）。

修法：`ActiveMsgClient.cancelTask` 改成冪等——404 `TASK_NOT_FOUND` 算取消成功並回
`alreadyGone: true`，面板據此說「在遠端已不存在（多半已經發過了），已從列表移除」；
其餘錯誤照拋。迴歸測試在 `utils/activeMsgClient.test.ts`。角色工具側的 cancel 一併受益。

### 5. 每天/每週任務觸發後，列表仍顯示原始時間 + 「待觸發」（已修）

`[8130e324] 2026/7/26 01:12:00 · 每天 … 待觸發`，實際遠端 `next_send_at` 已順延到 07-27。
顯示的是創建時的錨點而不是下一次觸發時間，看起來像「過點了還沒觸發」。

修法：時間統一走 `currentOccurrenceMs`（本來只有 debug 面板在用，已挪到 `amsg2Tasks`），
按週期推到當前這一次。顯示任務時間的三處——設置面板、`list_active_messages` 的返回、
注入角色的排程現狀塊——全部改用它，口徑保持一致。

順帶把「已到點」拆細了：一次性任務過點後，遠端那行還在 = `已到點·待處理`（cron 還沒消費），
遠端已經沒有 = `已觸發`（發出去了或被閘作廢了），底帳沒拉到才回到中性的「已到點」。
實測時那兩條卡著的任務 debug 面板寫「已過點未發」、遠端卻是 404，就是這一檔缺失導致的誤讀。

---

## 三、噪音 / 小事

### 6. 每次排程都有一條 worker warn（已修）

```
[amsg-server] avatarUrl 不合法，已置空： avatarUrl 不是合法 URL
```

角色頭像是本地 base64，不是 URL。功能沒受影響，但每條 `schedule-message` 都會刷一條 warn。

修法：客戶端用 `toRemoteAvatarUrl` 按 worker 同一把尺（非 `data:`、≤2048 字符、http(s) URL）先篩，
不合格就不帶這個字段。它只用於推送通知圖標，傳了本來也是被置空，行為不變。

### 7. 「編輯」是取消+重建，任務 id 會變（已改文案，不改機制）

worker 日誌裡是 `POST /schedule-message` 緊跟 `DELETE /cancel-message`。列表裡的短 id 會換一個。
功能正常，只是如果有人按 id 追蹤任務會困惑。

worker 確實有 `PUT /update-message`，但它能改的字段不含 `messageType` 和 `apiUrl/apiKey/primaryModel`
——「固定 ↔ 自動」這類改模式的編輯還是得重建。為一半的場景引入第二條編輯路徑，換來的只是
編號不變，不划算。改成把編號變更說清楚：

- 面板：`任務已更新，編號換成 [xxxxxxxx]。`
- 角色工具：`原任務 [舊] 已換成 [新]（改期是重建，編號會變）。`
  替換時遠端取消失敗的話也會明說「原任務可能仍會觸發，請再取消一次」——這條以前完全沒告訴角色。

---

## 四、`docs/self-deploy-workers.md`（= 部署倉庫 README）與實際 UI 對不上（已修）

Cloudflare 面板改版後這些名字都變了，照文檔找不到：

| 文檔裡寫的 | 實際 |
|---|---|
| Storage & Databases → **D1** | Storage & databases → **D1 SQLite Database** |
| Workers & Pages → **Create** | Workers & Pages → **Create application** |
| 選 **Import a repository** | 選 **Continue with GitHub** |
| **Root directory** 填 `amsg` | Advanced settings 裡的 **Path** 填 `/amsg` |
| 「部署設置裡找到環境變量 / Secrets」 | 分兩處：構建變量在創建嚮導的 Advanced settings（Variable name / value，別點 Encrypt）；Secrets 要等部署完再去 Settings → **Variables and secrets** |

另外兩條：

- FAQ 說「在瀏覽器直接打開 `/capabilities`，能返回一段 JSON 說明 Worker 活著」——配了
  `AMSG_SERVER_TOKEN` 的話瀏覽器直接打開會得到 401 `INVALID_CLIENT_TOKEN`。這同樣說明 Worker 活著，
  但文檔沒寫，按字面理解會以為部署失敗。
- 部署進度頁不會自動刷新，會一直停在 Initializing（實測構建 28 秒就完成了，頁面卡了 5 分鐘）。
  需要提醒用戶手動刷新。

已按上表改完，另外補了 Build / Deploy command、Advanced settings 裡的 API token、
Secrets 要等部署完再填這幾處，開頭加了指向 `docs/amsg2-setup-walkthrough.md` 的鏈接。

---

## 五、跑通了的（迴歸基線）

- Git 導入部署：`deploy-prepare.sh` 正確把 Database ID 填進 `wrangler.toml`；`env.DB` 綁定、
  `crons = ["* * * * *"]` 都由倉庫配置自動帶上，不需要手動加
- `/capabilities` → `serverVersion 2.6.0-next.5`，features 含 client-state / chunking /
  partial-failure / agentic-hooks / agentic-scratch / vapid-public-key
- 「連接並啟用」冪等建表（`client_state` / `scheduled_messages`）
- 三種消息來源：固定 / 自動 / 提示詞，全部到點送達；AI 生成的兩種都按角色人設走，多段氣泡 + 表情正常渲染
- 三種重複：一次（發完刪行）/ 每天（`next_send_at` +1 天）/ 每週（+1 周錨點）
- 編輯、取消（遠端行確實被刪掉）
- 防穿幫閘：`強制發送` 照發；`自動作廢` 在「創建後又聊了天」的情況下正確作廢，
  worker 日誌出現 `[amsg:expire-skip]`，客戶端沒收到消息
- 服務端工具循環入口有走到（日誌出現 `[amsg:agentic]`）

> 備註：`固定` 類型不顯示「到點時用戶正在聊天」策略選項（固定內容恆等於強制發送），這是設計如此，不是 bug。
