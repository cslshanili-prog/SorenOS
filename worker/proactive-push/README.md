# 主動消息 Push 加速器 · 部署劇本（全按按鈕版）

**作用**：給主動消息 1.0 提供"到點喊醒瀏覽器"的能力。cron 每分鐘掃 D1，
對心跳活著的訂閱發 wake push。AI 生成全在瀏覽器本地跑，Worker 看不到
任何聊天內容。

**費用**：Cloudflare 全程免費檔，30 分鐘主動消息隨便用。

**文件說明**：
- `worker.bundle.js` — **要複製粘貼到 CF 面板的 Worker 代碼**（單文件，零依賴）
- `vapid-gen.html` — 本地打開就能生成 VAPID 密鑰對（**你要打開**）
- `src/` — Worker TypeScript 源碼（開發用，你用不到）
- `schema.sql` — D1 建表 SQL（你要複製到 CF 面板執行）
- `wrangler.toml` — 舊 CLI 方式的配置文件（你不用管，備著以後開發參考）

---

## 階段 1 · 拿到 VAPID 密鑰對

1. 雙擊打開 `worker/proactive-push/vapid-gen.html`（任何瀏覽器都行）
2. 點 **"生成一對新密鑰"** 按鈕
3. 看到 **Public Key** 和 **Private Key**，兩個都點 **複製** 存到記事本

> 全程在瀏覽器本地跑，不上傳任何服務器。生成一次長期複用。

---

## 階段 2 · CF 面板 · 建一個空 Worker

1. 打開 https://dash.cloudflare.com → 左邊欄 **Workers & Pages** →
   **Create**（或 **Create application**）
2. 頂上切到 **Create Worker** 標籤
3. Worker name 填 `proactive-push`（也可以改別的），點 **Deploy**
4. 部署完跳出來一個"你的 Worker 已啟動"頁面，點 **Edit code**
5. 進到編輯器，把左邊默認的 `worker.js` 裡所有代碼**全選刪掉**
6. 打開 `worker/proactive-push/dist/worker.js`，**全選複製粘貼**到編輯器
7. 右上角點 **Deploy**（藍色按鈕）
8. 回到 Worker 詳情頁，記下它的 URL，形如
   `https://proactive-push.你的子域.workers.dev`。抄到記事本。

---

## 階段 3 · CF 面板 · 建 D1 數據庫

1. 左邊欄 **Workers & Pages** → **D1**（在下拉或 Storage & Databases 裡）
2. 點 **Create database**
3. Name 填 `proactive-db`，點 **Create**
4. 進到數據庫詳情頁，左邊切到 **Console** 標籤
5. 打開 `worker/proactive-push/schema.sql`，**全選複製粘貼**到 Console
6. 點 **Execute**，應看到 "Successful" 之類的 OK 提示

---

## 階段 4 · CF 面板 · 把 D1 綁定到 Worker

1. 回到 **Workers & Pages** → 點你剛建的 `proactive-push`
2. 頂上切到 **Settings** 標籤
3. 找到 **Variables and Secrets** 或 **Bindings**（CF 界面名字偶爾變）
4. 滾動到 **D1 database bindings**，點 **Add binding**
5. **Variable name** 填 **`DB`**（就是兩個字母大寫，和代碼裡一致）
6. **D1 database** 下拉選剛建的 `proactive-db`
7. 點 **Save** 或 **Deploy**

---

## 階段 5 · CF 面板 · 填密鑰和配置

回到 Worker 的 **Settings → Variables and Secrets**。

需要加 **5 個變量**，每個都點 **Add variable** 或 **+**：

| 名字 | 類型 | 值 |
|---|---|---|
| `VAPID_PUBLIC_KEY` | Secret | 階段 1 的 Public Key |
| `VAPID_PRIVATE_KEY` | Secret | 階段 1 的 Private Key |
| `VAPID_SUBJECT` | Text | `mailto:你的郵箱@xxx.com` |
| `CLIENT_TOKEN` | Secret | 隨便一串長字符串（建議 32 字符以上隨機） |
| `HEARTBEAT_WINDOW_MS` | Text | `300000`（5 分鐘，可選；不填默認也是 5 分鐘） |

**Text 和 Secret 的區別**：
- Secret 之後就看不到原值了（安全）
- Text 之後可以看到可以改
- 私鑰類的必須用 Secret

填完每一項記得點 **Save**。全部填完後點頁面底部的 **Deploy** 重新發布。

---

## 階段 6 · CF 面板 · 加 cron 定時

1. Worker 詳情頁 → **Triggers** 標籤（或 **Settings → Triggers**）
2. 找到 **Cron Triggers**，點 **Add Cron Trigger**
3. 在 **Cron expression** 裡填 `* * * * *`（每分鐘一次）
4. 點 **Add trigger** 或 **Save**

---

## 階段 7 · 測一下

在你的手機或電腦瀏覽器打開：

```
https://proactive-push.你的子域.workers.dev/health
```

應該看到：

```json
{"ok":true}
```

看到就對了 ✓

---

## 階段 8 · 告訴我這兩個值

把下面兩個發我：

1. **Worker URL**（階段 2 第 8 步記下的那個）
2. **階段 1 的 Public Key**（不是 Private！）
3. **階段 5 填的 `CLIENT_TOKEN`**

我會把它們填到前端源碼 `utils/proactivePushConfig.ts` 的常量裡並提交。
你重新 build 前端後，設置裡會出現"主動消息 Push 加速"section，打開
開關即可。

---

## 驗證（可選）

部署完之後，想看到底工作不工作：

1. app 裡給任意角色開主動消息（任意 30 分鐘倍數的間隔）
2. 回到 CF 面板的 Worker 詳情頁，點 **Logs** 標籤 → **Begin log stream**
3. 到點時應看到類似：
   ```
   [cron] fired=1 dropped=0
   ```

---

## 常見問題

**Q：Worker 代碼改了怎麼重新部署？**

A：進 Worker 詳情頁 → **Edit code** → 貼新代碼 → **Deploy**。
D1 綁定、secret、cron 都保留。

**Q：免費額度夠嗎？**

A：30 分鐘主動消息每人每天約 768 次請求（48 次 wake + 720 次心跳），
免費檔 10 萬/天夠 130+ 人。D1 讀 500 萬/天更寬鬆。

**Q：iOS 用戶收不到？**

A：iOS Safari 16.4+ 必須先"添加到主屏"把網站裝成 PWA 才能收 push。
普通 Safari 標籤頁收不到。這是 Apple 的限制不是我們能改的。

**Q：想停掉 push 加速？**

A：前端 app 設置裡關掉開關就行——不需要動 Worker。或者在 CF 面板
把 Cron Trigger 刪掉，所有人的 push 都停發。

**Q：怎麼徹底刪掉？**

A：CF 面板 → Worker 詳情 → Manage → Delete。D1 同樣在 D1 列表裡
右鍵刪除。
