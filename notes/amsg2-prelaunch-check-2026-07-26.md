# amsg2 多任務波上線前檢查報告

> 檢查時間：2026-07-26。範圍：`dev` 上 2026-07-18 實機驗證之後的整波 amsg2 提交
> （bf23461 防穿幫閘 → 3b4af16 送達歸屬精確 id，共 12 個），外加全鏈路迴歸。
> 結論先行：**可以上線**。全鏈路本地實測 57/57 通過；查出並修掉 1 個真缺口
> （舊 worker 版本探測不出來，違背「不靜默降級」設計），另修 1 個衍生誤報徽標。
> 線上給定 worker 因共享密鑰未提供只探到 401 邊界（見「線上 worker」節）。

## 檢查方法

| 項 | 做法 | 結果 |
|----|------|------|
| 靜態接線核對 | 精讀排程→同步→到點→送達→作廢全鏈 14 個文件，逐字段對 metadata / client_state key / 判定窗口 | 閉合，見下節 |
| 測試基線 | `pnpm vitest run` 全量 | 101 文件 / 1153 例全綠（修復後 102 / 1166） |
| 類型檢查 | `npx tsc --noEmit` 全量 | 74 個錯誤全部為 2026-06-28 之前的歷史基線（MemoryPalace / Schedule / Bank / proactive-push 等），amsg2 波及文件 0 錯誤 |
| bundle 新鮮度 | `pnpm build:workers` 後 `git diff` | 零 diff——提交的 `worker/amsg/worker.bundle.js` 與 `public/amsg-worker.bundle.js` 就是當前源碼產物（211.8KB） |
| 全流程實測 | 新增 `scripts/amsg2-e2e-harness.mjs`：本地跑**提交的同一份 bundle**（node:sqlite 模擬 D1 語義、真實 VAPID + RFC8291 aes128gcm 加解密、mock LLM、http 橋 + 前端同款 amsg-client） | **57/57 通過** |

## 全流程實測覆蓋（S0-S7）

1. **S0 鑑權/CORS/capabilities**：無/錯共享密鑰全端點 401；OPTIONS 預檢 204 + `*`；
   capabilities 報的 `serverVersion` 與 `package.json` 聲明的 amsg-server 一致
   （當前 `2.6.0-next.7`，harness 不寫死版本號，順帶能抓「升了依賴忘重打 bundle」），
   六項 features 齊全。
2. **S1 連接流程**：init-tenant 冪等建表、get-user-key 派生加密通道、vapid-public-key 與 env 一致。
3. **S2 fixed 一次性任務**：排程 → cron 到點 → push 解密驗文一致；metadata 帶
   `amsgClientTaskId`（送達歸屬鍵）；GET /messages 行帶 charId/clientTaskId 投影；發完出清。
4. **S3 滿血 v2 多任務**：fire_pack v2 到點現場渲染（驗證吃的是雲端模板不是凍結 prompt）、
   時間槽/任務指令槽正確填值、~256KB 大值經存儲層分塊讀回逐字完整、RECALL 工具循環兩輪、
   旁白保序、directives 只掛最後一條 push、`amsgOccurrenceMs` 隨每條 push、橫幅淨化文本、
   daily fire 後 next_send_at +24h、cancel 後出清。
5. **S4 防穿幫閘·錨點**：一次性 expire 任務錨點後有新用戶消息 → onBeforeFire `{skip}`，
   零 LLM 零 push，任務照常出清（skip 出口不進 failed/重試）。
6. **S5a 活躍租約**：chat_presence 新鮮 → 無 fire_pack 也攔（第一道快速門語義正確）。
7. **S5b 狀態不全不降級**：租約過期 + 無 fire_pack → 拋 `AMSG2_FIRE_STATE_MISSING`，
   零 LLM 零 push，任務留在遠端等重試（不拿排程時凍結的 prompt 頂包，用戶看不出它是舊的）。
8. **S6 force**：新鮮租約 + 錨點已前進也照發，且照走滿血渲染（鬧鐘語義）。
9. **S7 clear-client-state**：設置頁「清除雲端狀態」刪乾淨。

## 靜態核對結論（逐環節）

- **排程**：面板與工具兩條路徑 payload 同構（metadata 五件套
  `amsgClientTaskId / amsgExpirePolicy / amsgRecurrence / amsgAnchorMs / amsgTaskInstruction`
  齊全）；封頂 5 個待觸發；替換「先建後刪」，取消失敗保留舊記錄標錯不留幽靈任務。
- **同步**：`markAmsgStateDirty` 只對有待觸發 AI 任務的角色生效；去抖 15s / 切後台立即；
  租約心跳只在本地 fetch 路徑開（instant 路徑提前 return，天然不重複）。
- **到點**：worker 閘順序正確——presence 檢查在 fire_pack 缺失判定**之前**（新任務
  fire_pack 沒同步上時輕量心跳仍能攔）；雲端狀態缺任一份（fire_pack / tool_pack /
  tool_config）或任務缺 amsgTaskInstruction 一律拋錯不降級；occurrenceMs 從任務行
  next_send_at 攤平透傳。
- **送達**：吞沒閘只攔 `source==='scheduled'` 且帶策略字段的 push；緩存鍵
  `amsgClientTaskId:occurrenceMs` 同吞同放（5 分鐘 TTL 容亂序分段）；循環任務判定
  錨定到點時刻而非送達時刻。
- **作廢回執**：檢出（±10 分鐘對稱窗）→ 台帳去重（封頂 10 條、未告知優先保留）→
  注入 →發送成功才標已告知；`hasDeliveredProactiveNear` 按精確 clientTaskId 歸屬，
  不拿別的任務的送達抹本任務的回執。
- **面板**：遠端對帳失敗置 null 不誤傷；「關閉 2.0」以遠端全量清單為準、
  投影不可用退本地清單、取消失敗保留可重試。

## 查出並修掉的問題

### 1. 舊 worker（next.4 時代粘貼部署）探測不出來 → 已修

`ActiveMsgGlobalSettingsModal` 的「重新粘貼部署」探測只查四個 features，但實測對比
npm 上 `amsg-server@2.6.0-next.4` 與 `next.5` 的 `SERVER_FEATURES` **完全相同**，而這波
依賴的兩個 next.5 能力（GET /messages 投影、onBeforeFire `{skip}` 出口）沒有獨立
flag。後果：7-18 實機驗證時代的舊部署配上新前端，探測顯示「最新」，但防穿幫閘在
worker 側靜默不存在（skip 不生效，靠客戶端吞沒兜底但通知橫幅攔不住）、任務列表因
投影缺失全部誤標「遠端不存在」——正好違背 capabilities 探測「不靜默降級」的設計初衷。

**修法**：新增 `utils/amsgWorkerVersion.ts`（semver + 數字化 prerelease 比較，13 例單測），
探測改為 features 齊全 **且** `serverVersion ≥` 門檻版本；解析不了的版本串按不達標
處理（寧亮牌不靜默）。

門檻跟著依賴走，當前釘在 `2.6.0-next.7`（有單測釘住它與 `package.json` 聲明一致，
省得升了依賴忘記複核）。next.4 之後加的能力上游都沒發獨立 flag，features 清單幾乎
沒動過，只能靠版本號識別：next.6 的任務佔位租約（`lease_until`，帶工具的 AI 任務經常
跑過一分鐘，沒有佔位會被相鄰 cron tick 重複領走、重複推送）、next.7 的 hook `writeState`
與 Web Push 大小護欄。停在舊版的部署重貼一次代碼、在設置頁點一次「連接」
（走 `POST /init-tenant` 自動補列）即可。

### 2. 舊 worker 下任務列表徽標誤報 → 已修

`ActiveMsg2SettingsModal` 遠端對帳：老 worker 返回的行 charId 全為 null 時，過濾出的
空集合會讓每個待觸發任務都掛「⚠ 遠端不存在」。改為「有行但全無 charId → 視為投影
不可用 → 整體置 null 關掉徽標」，與「關閉 2.0」路徑的本地回退同一口徑。

### 3. 順手：文檔過期

`notes/amsg2-reenable-guide.md` 停在 2026-07-17（多任務波之前），已刷新：多任務/防穿
幫閘摘要、新增五個模塊的接入點表、amsg-server next.7 依賴說明、體檢腳本入口。

## 線上 worker（https://sullyos-amsg.yukine0v0.workers.dev/）

所有端點強制校驗共享密鑰（`X-Client-Token`），未提供密鑰只能驗證到：401 邊界行為
正確、報錯格式與 amsg-server 一致（`INVALID_CLIENT_TOKEN`）。**上線前請自查兩項**
（任一方式）：
1. 前端設置頁連上後看「重新粘貼部署」牌子——修復後的探測會同時查 features 與
   `serverVersion ≥ 2.6.0-next.7`；不亮即為最新 bundle；
2. 或帶密鑰手查：`curl -H "X-Client-Token: <共享密鑰>" <workerUrl>/capabilities`，
   確認 `serverVersion` 為 `2.6.0-next.7`（本倉當前 bundle 內嵌版本）。
若是 7-18 之前粘貼的部署，需要用設置頁「複製 Worker 代碼」重新粘貼一次
（部署順序：worker 先於前端發佈，順序反了不炸、只是滿血閘等 worker 跟上才生效）。

## 已知設計假設（不是缺陷，上線不阻塞）

- **amsg2 與 instant push 互斥**（代碼註釋既定假設）：兩者同時配置時聊天走 instant
  路徑，amsg2 的對話內工具、排程現狀塊注入、活躍租約心跳不生效；面板排程、到點
  觸發、送達兜底不受影響。當前 UI 未強制二選一，靠用戶自覺。
- **通知橫幅無法追回**：吞沒閘攔的是聊天流與副作用，OS 已彈的橫幅頁面線程無權收回；
  防橫幅主力是 worker 預檢 + 租約（本次實測均生效）。
- tsc 全量 74 個歷史錯誤與本波無關（基線早於 amsg2，多在 MemoryPalace / Schedule 等），
  `pnpm build` 不跑 tsc 不受影響；建議另開清理任務。
