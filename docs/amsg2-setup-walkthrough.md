# 主動消息 2.0 · 從零開始的部署手冊

「主動消息 2.0」讓角色到點自己給你發消息——App 關著、手機鎖屏也能收到。

它需要一個只屬於你的小後端（一個 Cloudflare Worker + 一個數據庫）。**全程只在網頁上點，不用裝任何東西、不用敲命令**。

裝法有三條，選一條走完就行：

| | [在 SullyOS 裡裝](#在-sullyos-裡裝推薦) | [用 Cloudflare 的部署按鈕](#用-cloudflare-的部署按鈕) | [跟著六步裝](#第一步--把後端倉庫-fork-一份) |
|---|---|---|---|
| 要幾個帳號 | 只要 Cloudflare | GitHub + Cloudflare | GitHub + Cloudflare |
| 花多久 | 大約 2 分鐘 | 大約 5 分鐘 | 大約 15 分鐘 |
| 你要經手的東西 | 一枚 Token | 一枚 Token 都不用，但要填 4~5 個密鑰 | 同左，另外還要建庫、連倉庫 |
| 適合 | **絕大多數人，手機上尤其**| 想讓 Cloudflare 替你建倉庫 | 想看清每一步在幹什麼 |

三條路裝出來的東西完全一樣，以後更新也都是在 SullyOS 裡點一下。

> 還有第四條：把後端代碼從網頁上覆制、貼進 Cloudflare 的在線編輯器，什麼帳號之外的東西都不經手。見文末的[附錄 · 不用 GitHub 怎麼裝](#附錄--不用-github-怎麼裝)。

---

## 在 SullyOS 裡裝（推薦）

只要一個 Cloudflare 帳號（用 GitHub 或郵箱都能註冊），不需要 GitHub。密鑰全部由 SullyOS 就地生成，你一個都不用抄。

### 第 1 步 · 建一枚 API Token

打開 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → 最下面的 **Custom token** → **Get started**。

**Permissions** 這三行都要加上（點 *+ Add more* 加行）：

| 類型 | 名稱 | 權限 |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |

**Account Resources** 選你要把後端裝進去的那個帳號。

**TTL** 那兩個日期框：**Start Date 留空**。填了未來的日期，這枚 Token 要到那天才生效，在那之前用會一直被 Cloudflare 拒掉。

點 **Continue to summary** → **Create Token**，把生成的那串複製下來（**它只顯示這一次**）。

### 第 2 步 · 粘進 SullyOS

打開 SullyOS → 底部齒輪 **系統設置** → 滾到最底部 → **主動消息 2.0** 右邊的 **配置** → 最上面那塊 **一鍵部署**。

把 Token 粘進輸入框，點 **開始部署**。等十幾秒就好了。

這十幾秒裡它替你做完了：建數據庫、上傳後端代碼、寫入全部密鑰、加上每分鐘的定時觸發、開好訪問地址，然後連上。做完就能用了。

### 中途可能會問你兩件事

**「這枚 Token 能用在多個帳號上，裝到哪個？」** —— 你的 Cloudflare 名下不止一個帳號時會問。點一下要裝的那個就繼續了。（建 Token 時在 Account Resources 裡只選一個帳號的話，這一步不會出現。）

**「給這個帳號起一個 workers.dev 子域名」** —— 全新的 Cloudflare 帳號才會遇到。這個名字全 Cloudflare 唯一，定了之後是這個帳號所有 Worker 共用的，起一個自己認得的就行，之後後端地址會長成 `sullyos-amsg.你填的.workers.dev`。

### 關於這枚 Token

瀏覽器不能直接調 Cloudflare 的接口（它不給跨域），所以部署時這枚 Token 會經過 SullyOS 的網絡代理 Worker 轉發一次。這一點寫在按鈕下方，介意的話可以走下面兩條路。

部署完成後，它會作為密鑰存進**你自己的那個 Worker**——以後在設置頁點「更新 Worker」，是那個 Worker 拿著它自己更新自己，不再經過瀏覽器。SullyOS 這邊用完就丟，不保存。

裝完直接跳到[第六步](#第六步--給角色排第一條主動消息)給角色排第一條消息。

---

## 用 Cloudflare 的部署按鈕

Cloudflare 會替你把倉庫、數據庫、定時任務一次性建好，你只要在一個頁面上把幾個密鑰填進去。這條路需要一個 GitHub 帳號。

### 先在 SullyOS 裡把要填的東西準備好

打開 SullyOS → 底部齒輪 **系統設置** → 滾到最底部。

**推送憑據 (VAPID)**：點標題右邊的小箭頭展開 → **生成 VAPID 密鑰對 →** → 彈窗裡點 **生成新密鑰對** → **保存**。再點開一次，把「VAPID 公鑰」和「VAPID 私鑰」分別複製出來存好。

**主動消息 2.0**：點這一節右邊的 **配置** → 展開 **手動部署 Worker（想自己一步步來）** → 找到 **AMSG_MASTER_KEY** 點 **生成並複製**，存好。再往下滾到 **共享密鑰（可選）**，點右邊的 **隨機**，也存好。

### 點按鈕

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/Tosd0/sullyos-workers/tree/main/amsg)

<https://deploy.workers.cloudflare.com/?url=https://github.com/Tosd0/sullyos-workers/tree/main/amsg>

跳過去之後：

1. **Git account** 選你的 GitHub 帳號（第一次用會讓你授權，同意即可）
2. 往下每個密鑰一個輸入框，把剛才存的幾串填進去。每個框下面都寫了它是什麼、去哪兒取
   - `VAPID_EMAIL` 和 `AMSG_SERVER_TOKEN` 是可選的，不填也能跑
3. 點右下角 **Deploy**

頁面會跳到構建進度，半分鐘左右完成。數據庫、每分鐘的定時觸發器、workers.dev 地址都會自動配好，不用管。

> **如果你已經裝過一個**：`Project name` 和數據庫名默認都叫 `sullyos-amsg`，跟已有的那個撞名。而且 **D1 那欄會自動選中同名的已有數據庫**——不改的話兩個後端會共用一個庫。裝第二個的話，把項目名和數據庫名都改一下（比如加個後綴）。只裝一個就不用操心。

建好之後，Worker 的 **Overview** 頁裡標題下面那個 `https://xxx.workers.dev` 就是地址，複製它，然後跳到[第五步](#第五步--回-sullyos-連上)把它填回 SullyOS。

---

## 跟著六步裝

下面是把上面那幾下拆開的版本：每一步在建什麼、填到哪兒都看得見。上面兩條路已經裝好了的話，這六步跳過就行。

---

## 第一步 · 把後端倉庫 fork 一份

1. 打開 <https://github.com/Tosd0/sullyos-workers>
2. 點頁面右上角的 **Fork** → 保持默認 → **Create fork**

完成後你的帳號下就多了一個同名倉庫。以後上游有更新，你回到這個頁面點一下 **Sync fork** 就行，Cloudflare 會自動重新部署。

---

## 第二步 · 建一個數據庫

角色的定時任務要存在數據庫裡。

1. 打開 <https://dash.cloudflare.com> 並登錄
2. 左側菜單 **Storage & databases** → **D1 SQLite Database**
3. 右上角 **Create Database**
4. **Name** 填 `sullyos-amsg`，其餘保持默認，點 **Create**
5. 建好後會自動跳進這個庫的 Overview 頁。頁面上方有一串像 `6d726bb3-6ea3-45dd-80d8-72ad6bd49446` 的編號，這就是 **Database ID**。點它右邊的複製按鈕，先存在記事本里，下一步要用。

> 表結構不用管，後面在 SullyOS 裡點「連接」時會自動建好。

---

## 第三步 · 用剛才的倉庫創建 Worker

1. Cloudflare 左側菜單 **Compute** → **Workers & Pages**
2. 右上角 **Create application**
3. 選 **Continue with GitHub**（第一次用會跳到 GitHub 讓你授權，同意即可）
4. 在出現的倉庫列表裡選中第一步 fork 的 **sullyos-workers**，點右下角 **Next**
5. 頁面往下滾，進入 **Set up your application**，按下面填：

   | 位置 | 填什麼 |
   |------|--------|
   | Project name | `sullyos-amsg` |
   | Build command | `sh ./deploy-prepare.sh` |
   | Deploy command | 保持默認的 `npx wrangler deploy` |

6. 點下方的 **Advanced settings** 展開，繼續填：

   | 位置 | 填什麼 |
   |------|--------|
   | Path | `/amsg` |
   | API token | 下拉選 **Create new token**，然後在出現的 **API token name** 裡隨便起個名字（比如 `sullyos-amsg build token`）；它會顯示「A new token will be created automatically」 |
   | Variable name | `D1_DATABASE_ID` |
   | Variable value | 粘貼第二步複製的那串 Database ID |

   > Variable value 旁邊有個 **Encrypt** 按鈕，**不要點**——這個值需要在構建時被讀出來。

7. 點右下角 **Deploy**

頁面會跳到構建進度。**這個頁面不會自動刷新**，看起來一直卡在 Initializing 是正常的，手動刷新一下就能看到真實狀態。順利的話 30 秒左右完成，日誌裡會出現這兩行：

```
[deploy-prepare] 已把 D1 database_id 填進 wrangler.toml。
env.DB (sullyos-amsg)   D1 Database
```

![構建成功](./images/amsg2-setup/build-success.png)

> 數據庫綁定和「每分鐘檢查一次」的定時觸發器都寫在倉庫裡，會自動帶上，不用手動加。

---

## 第四步 · 填鑰匙（Secrets）

這一步要在 SullyOS 和 Cloudflare 之間來回一次，先把 SullyOS 那邊的值生成出來。

### 4a. 在 SullyOS 裡生成兩組值

打開 SullyOS → 底部齒輪 **系統設置** → 往下滾到最底部。

**先做「推送憑據 (VAPID)」**（這是瀏覽器推送用的簽名密鑰，全站共用一對）：

1. 點標題右邊的小箭頭展開 → 點 **生成 VAPID 密鑰對 →**
2. 彈窗裡點 **生成新密鑰對**，會出現「VAPID 公鑰」和「VAPID 私鑰」兩段
3. 點 **保存**
4. 再點開一次，用每一欄右上角的 **複製** 分別把公鑰、私鑰存到記事本

**再做「主動消息 2.0」**：

1. 點這一節右邊的 **配置**
2. 彈窗裡點 **手動部署 Worker（想自己一步步來）** 右邊的 **展開**
3. 找到 **AMSG_MASTER_KEY** → 點 **生成並複製**，屏幕上會顯示 `AMSG_MASTER_KEY=` 加一串 64 位字符，整行存進記事本
4. 往下滾到 **共享密鑰（可選）** → 點右邊的 **隨機**，它會生成一串密碼自動填進輸入框，下方顯示 `AMSG_SERVER_TOKEN=` 開頭的整行並複製到剪貼板。**這一串等下也要填到 Cloudflare**，同樣整行存進記事本（輸入框是密碼框看不見內容，下方那行就是給你抄的）

> 「共享密鑰」的作用：填了以後，別人光知道你的 Worker 地址也調不動它。

### 4b. 回 Cloudflare 填進去

1. 回到 Cloudflare 的 Worker 頁面（Workers & Pages → `sullyos-amsg`）
2. 頂部選 **Settings**
3. 最上面一塊就是 **Variables and secrets**，點右邊的 **+ Add**
4. 右側滑出的面板裡，每一條都是「Type / Variable name / Value」三格。記事本里 `變量名=值` 那樣的整行可以直接粘進去，Cloudflare 會自動拆開填好名字和值兩格。填完一條點下面的 **Add variable** 加下一條，一共五條：

   | Type | Variable name | Value |
   |------|---------------|-------|
   | Secret | `AMSG_MASTER_KEY` | 4a 生成的那串 64 位字符 |
   | Secret | `VAPID_PUBLIC_KEY` | VAPID 公鑰 |
   | Secret | `VAPID_PRIVATE_KEY` | VAPID 私鑰 |
   | Text | `VAPID_EMAIL` | `mailto:你的郵箱` |
   | Secret | `AMSG_SERVER_TOKEN` | 4a 那串「共享密鑰」 |

5. 五條都填完，點右下角 **Deploy**

> ⚠️ VAPID 那兩條**必須**和 SullyOS 面板裡的是同一對。整個站點只有一個瀏覽器推送訂閱，Worker 用別的密鑰對去簽名，推送會被瀏覽器直接丟掉——表現就是「哪兒都顯示正常，就是收不到消息」。

填完可以順手確認兩件事（都在同一個 Settings 頁往下滾）：

- **Trigger events** 裡有一條 `Cron / scheduled() / * * * * *`
- 頂部 **Bindings** 標籤裡有一個名為 `DB` 的 D1 database

### 4c. 複製 Worker 地址

回到 Worker 的 **Overview** 頁，標題下面那個 `https://xxx.workers.dev` 就是地址，複製它。

---

## 第五步 · 回 SullyOS 連上

**系統設置** → **主動消息 2.0** → **配置**，滾到「當前狀態」這一塊：

1. **WORKER 地址** 粘貼上一步複製的地址
2. **共享密鑰（可選）** 確認裡面就是 4a 生成的那串（如果空了就重新粘一次）
3. 點 **連接並啟用**

右上角變成綠色的 **已連接** 就成功了——數據庫表也是這一下自動建好的。

4. 繼續往下，點 **開啟通知與推送**，瀏覽器會彈出通知權限請求，選「允許」

「通知權限」顯示 **已開啟** 之後，後端部分就全部完成了。

---

## 第六步 · 給角色排第一條主動消息

1. 回到桌面，進入任意角色的聊天頁
2. 點輸入框左邊的 **＋**
3. 在彈出的功能面板裡找到 **主動消息 2.0**（面板有好幾頁，可以左右翻）
4. 把 **啟用主動消息 2.0** 的開關打開，下面就會出現任務列表和新建表單

![任務面板](./images/amsg2-setup/task-panel.jpg)

新建一個任務要選三樣東西：

**① 消息怎麼來**

| 類型 | 說明 |
|------|------|
| 固定 | 到點直接發你寫好的那段話，不經過 AI |
| 自動 | 到點讓角色按人設和最近的聊天自己想一句 |
| 提示詞 | 你給個方向（比如「提醒我喝水」），角色圍繞它自由發揮 |

**② 什麼時候發**

「首次發送時間」選日期時間，「重複方式」選 一次 / 每天 / 每週。

**③ 到點時如果你正在聊天怎麼辦**（選「自動」或「提示詞」時才會出現）

| 選項 | 行為 |
|------|------|
| 自動作廢 | 你剛剛還在跟角色聊，這條就不發了，避免答非所問 |
| 強制發送 | 鬧鐘型，不管你在不在聊都照發 |

填好點 **新建任務**。到點後消息會以系統通知的形式彈出來，同時落進聊天記錄裡：

![收到的主動消息](./images/amsg2-setup/received-messages.jpg)

任務列表裡每條都能單獨 **編輯** 或 **取消**。

---

## 出問題時怎麼查

**排好的任務到點沒反應**

先看 SullyOS 裡 **系統設置 → 主動消息 2.0** 頂上的「體檢」，展開「定時任務」那一行。每條到點還沒發出去的任務都會單獨列出來，說明它現在是哪種情況：在等下一次重試、正在發、在排隊（同一個角色另一條正在發）、一直沒開始發，或者開始發過卻沒發完。失敗過的會帶上報錯原文，點「原文」展開就能看到中轉站或模型接口回的原話。Worker 每分鐘那一跳自己報的錯（比如表結構對不上、推送憑據沒配）也列在這裡。

體檢裡寫著「沒留下任何報錯」、「開始發過卻沒發完」，或者需要看更早的記錄時，再按下面兩步去 Cloudflare 看：

1. Cloudflare → 你的 Worker → **Settings** → 往下找 **Trigger events**，確認有 `* * * * *` 那條。沒有的話：連倉庫裝的多半是第三步 Path 填錯、沒指到 `amsg` 目錄；照附錄手動貼代碼裝的，就是那條定時觸發器還沒加（附錄 E）。用部署按鈕裝的這條是自動配好的，一般不會缺。
2. 還是不行就開日誌：同一頁往下找 **Observability** → **Logs** 那一行右邊的鉛筆 → 把開關打開 → **Deploy**。之後到 頂部 **Observability** 標籤就能看到每分鐘一條的 `* * * * *`，點開能看到那次運行有沒有報錯。

**看起來都正常，就是收不到消息**

九成是 VAPID 對不上。回第四步核對：Cloudflare 裡的 `VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` 必須和 SullyOS「推送憑據 (VAPID)」面板裡顯示的完全一致。改過之後要在 SullyOS 裡重新點一次「開啟通知與推送」。

**面板上說「這次沒寫出要說的話」，或者即時對話提示「模型這輪沒有生成內容」**

後端跑完了，模型也回了話，只是回來的內容裡沒有能發出去的正文。這種情況有好幾種成因，要看日誌才分得清：

1. 按上面的辦法打開 Observability 日誌，到 **Observability** 標籤裡搜 `amsg:skip-diag`，點開最近的那一條。
2. 對照這幾項看：
   - `finishReason` 是 `length`、`reasoningChars` 很大：思考把輸出額度用光了，正文沒來得及寫。換個不帶思考的模型試試
   - `finishReason` 是 `content_filter`，或者 `contentType` 是 `null` 且 `toolCalls` 是 `0`：被模型那邊的內容審核攔下了
   - `contentChars` 有數、`visibleChars` 是 `0`：模型把整段話都寫進了思考塊（`<think>` 裡）
   - `contentType` 是 `array`：這個接口返回的格式後端認不出來，換個接口地址或渠道試試
3. 還是看不出來的話，去 Worker → **Settings** → **Variables and secrets** 加一個變量 `AMSG_DEBUG_LLM_RAW`，值填 `1`。之後再遇到，同一條日誌裡會多出一個 `raw`，是模型回覆的開頭幾百字。這段會帶上聊天內容，查完記得把變量刪掉。

**SullyOS 裡點「連接」失敗**

提示裡如果直接寫了「缺 XXX」，那就是後端自己報的，照著補完再點一次就行（第四步那張表列了每個密鑰是什麼；用部署按鈕裝的去 Worker → **Settings** → **Variables and secrets** 補）。

其它情況按這幾條排：

- 地址是不是抄全了（要帶 `https://`，末尾不要多斜槓）
- 「共享密鑰」和 Cloudflare 裡的 `AMSG_SERVER_TOKEN` 是不是一模一樣
- 直接在瀏覽器打開 `你的地址/config-check`：後端會自己列出配置齊不齊。`"ok": true` 就是鑰匙都填對了，問題在地址或密鑰沒對上；`"ok": false` 時後面的 `message` 會寫明缺哪一樣、去哪兒補。什麼都打不開才是後端沒起來，去看第三步的構建日誌。
- 上面這個地址掛梯子能打開、不掛就打不開：那是 `workers.dev` 在國內連不上，不是後端的問題，見下面「國內連不上 workers.dev 怎麼辦」。

**連上了，但 `config-check` 的 `warnings` 裡有東西**

那幾條是「能跑，但有一塊是啞的」，界面上看不出來，所以單獨列在這兒：

- `VAPID_MISSING`：任務建得成，到點一條都推不出去。回第四步補那兩個密鑰
- `MASTER_KEY_FORMAT`：`AMSG_MASTER_KEY` 不是 64 位十六進制，多半是粘貼時少了幾位
- `SERVER_TOKEN_MISSING`：沒設共享密鑰，這個地址知道的人都能讀寫你的任務。介意的話回第 4a 步生成一個

**上面都試過還是不行 / 想找人幫忙看**

打開 `你的地址/debug`，把返回的那段 JSON 整個貼給對方。它比 `config-check` 多報數據庫和定時任務的狀況，一份就夠判斷問題出在哪。這個地址只讀、不需要密鑰，也不會返回任何密鑰的值、你的用戶標識或消息內容，貼出來是安全的。

自己看的話重點是這幾項：`storage.missingColumns` 有東西 = 換了新版本沒重新點「連接並驗證」；`storage.pushSubscriptionRegistered` 是 `false` = 雲端沒有推送訂閱（去把推送開關關掉再打開）；`tick` 是 `stalled` = 有任務卡住了（到點很久一直沒人處理，或者開始發過又沒了下文），多半是定時觸發器沒配或者 Worker 半路被掐掉；`tick` 是 `failing` = 有任務在失敗重試，報錯原文不在這個地址裡，去體檢面板的「定時任務」那一行看。

**構建失敗，日誌裡寫 `D1_DATABASE_ID 是空的`**

那個變量沒設，或者設的時候點了 Encrypt。回到 Worker → **Settings** → 往下找 **Build** → **Variables**，加一個 `D1_DATABASE_ID`（普通變量，不加密），值是第二步的 Database ID，然後重新部署。

---

## 國內連不上 workers.dev 怎麼辦

`https://xxx.workers.dev` 這個域名在國內的網絡環境下打不開。表現是第五步點「連接」一直失敗，但把地址掛梯子打開又是正常的。

辦法是給它加一個門面：Worker、數據庫、定時任務全都留在 Cloudflare 不動，只在外面套一層 Deno——它什麼都不做，只把請求原樣轉給你的 Worker，再把回覆原樣送回來。Deno 給的是 `xxx.deno.net` 域名，國內能直連。

**先知道兩件事**

- **收消息不走這一層。** 推送是 Cloudflare 直接發給手機的，跟你用什麼地址打開設置面板是兩條獨立的路。所以這層就算掛了也收得到消息，只是改不了配置。
- **不用綁卡。** 沒驗證過的 Deno 帳號只有免費額度的 1%（每月一萬次請求），但 SullyOS 只在你點「連接」、打開設置面板、開推送這幾下才會請求 Worker，一萬次夠用很久。

**動手**

1. 打開 [console.deno.com](https://console.deno.com)，用 GitHub 帳號登錄，點右上角 **New Playground**
2. 回 SullyOS：**系統設置** → **主動消息 2.0** → **配置**，在「WORKER 地址」下面點開 **這個地址連不上？在外面套一層 Deno**，點 **複製 Deno 代理代碼**
3. 回 Playground，編輯器裡全選、粘貼覆蓋
4. 找到開頭 `UPSTREAM` 那一行，把引號裡的地址換成你自己的 `https://xxx.workers.dev`
5. 點右上角 **Deploy**，等構建跑完，標題旁邊會出現 `https://xxx.deno.net`
6. 把這個 `deno.net` 地址填回 SullyOS 的「WORKER 地址」，替換掉原來的，重新點一次 **連接並啟用**

> 不想把 Worker 地址寫在代碼裡的話，第 4 步可以不改，改成在 Playground 的 **Env Variables** 里加一個 `AMSG_UPSTREAM`，值填你的 Worker 地址。兩種都行，環境變量優先。

**怎麼確認這層是活的**

瀏覽器打開 `你的deno.net地址/__proxy-health`。看到 `"ok": true` 和你填的上游地址就對了；`"ok": false` 說明 `UPSTREAM` 那行還是原來的佔位符，沒改成自己的地址。

**一個會變的地方**

設置面板裡「去 Cloudflare 控制台」那個鏈接原本能直接跳到你那個 Worker 的頁面，靠的是從 `workers.dev` 域名反推 Worker 名字。換成 `deno.net` 之後推不出來了，會跳到 Worker 列表頁，自己再點一下。

---

## 以後怎麼更新

**在 SullyOS 裡點一下就行**：**系統設置** → **主動消息 2.0** → **配置**，「連接並啟用」下面有個 **更新 Worker**。有新版可更時它會變成綠色實心按鈕並寫明更新到哪一版，平時是淺色的，隨時可以點。

點了之後後端自己去取最新代碼覆蓋自己，你排好的任務、填過的密鑰、數據庫綁定都不動。更新完會自動驗證一次（順帶把新版可能要的表建好），並顯示一串代碼指紋，用來確認這次確實換了版本。

**用[「在 SullyOS 裡裝」](#在-sullyos-裡裝推薦)那條路裝的，這把鑰匙部署時已經放進去了**，直接點更新就行，下面這段跳過。

另外兩條路裝的，第一次點更新會提示缺一把鑰匙，同一塊地方就能補上（做一次就夠）：

1. 打開 <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → 拉到最下面的 **Custom token** → **Get started**
2. **Permissions** 只加一行：`Account` / `Workers Scripts` / `Edit`
3. **Account Resources** 選你的帳號；**Start Date 留空**，然後 **Continue to summary** → **Create Token**，複製顯示出來的那串
4. 回到 SullyOS 的這一塊，把它粘進 **給這台後端補一把更新用的鑰匙**，點 **裝上鑰匙**

之後更新就都是點上面那個按鈕了。

> 這一步只往你的 Worker 里加這一條密鑰，代碼、數據庫、已經填過的密鑰都不動。
>
> 這把鑰匙只能改 Workers，讀不到你的數據庫內容。寫進去之後就留在你自己的 Worker 裡，SullyOS 不保存。
>
> 也可以自己去 Cloudflare 面板加：Worker → **Settings** → **Variables and secrets** → **+ Add**，Type 選 `Secret`，名字填 `CF_API_TOKEN`，值粘貼那串，點 **Deploy**。效果一樣。

**不想加鑰匙的話**，按當初的裝法手動更新也行：

- 跟著六步裝的：打開你 fork 的那個倉庫，點 **Sync fork** → **Update branch**，Cloudflare 檢測到新提交會自動重新部署
- 用部署按鈕裝的：Cloudflare 給你建的是一個獨立倉庫（不是 fork，所以沒有 Sync fork 可點）。先把 <https://github.com/Tosd0/sullyos-workers/raw/main/amsg/worker.bundle.js> 下載下來，再打開你那個倉庫 → **Add file** → **Upload files**，把下載的文件拖進去覆蓋同名的那個，提交後會自動重新部署。這文件有四十多萬字符，網頁編輯器打不開，只能整個文件替換
- 照附錄手動貼代碼裝的：見附錄最後一節

> 頭一次用「更新後端」時，如果提示這台 Worker 還是舊版本、沒有這個功能，先按上面的辦法手動更新一次，之後就能在 SullyOS 裡點了。

---

## 附錄 · 不用 GitHub 怎麼裝

後端代碼就是一個文件，從網頁上覆制下來、貼進 Cloudflare 的在線編輯器就行（GitHub 上的公開文件不登錄也能看、也能複製）。適合不想用 GitHub、也不想讓 Token 經過任何中轉的人。代價是數據庫綁定和定時觸發器都得自己加，**以後每次更新也要重新複製粘貼一遍**。

這條路只替換六步裡的第一步和第三步，其餘步驟——第二步建數據庫、第四步填鑰匙、第五步連回 SullyOS、第六步排任務——完全一樣。

> **先看設備**：這份代碼有二十多萬個字符。電腦上覆制粘貼很輕鬆；手機瀏覽器就不一定吃得住，卡住或者貼不進去都有可能。手邊只有手機的話，走[在 SullyOS 裡裝](#在-sullyos-裡裝推薦)那條要省事得多——那邊手機上只要粘一枚 Token。

### A · 建數據庫

照第二步做，但**不用複製 Database ID**：這條路是在面板上按名字挑庫，不填 ID。

### B · 建一個空 Worker

1. Cloudflare 左側 **Compute** → **Workers & Pages** → 右上角 **Create application**
2. 選 **Start with Hello World!**（這一屏上面那兩個是連 GitHub / GitLab 的，跳過）
3. **Worker name** 填 `sullyos-amsg`——這個名字就是你以後的地址：`sullyos-amsg.xxx.workers.dev`
4. 點右下角 **Deploy**

十幾秒就好。這會兒它還只會回一句 Hello World，下一步把真代碼換進去。

### C · 複製後端代碼

瀏覽器打開（不用登錄）：<https://github.com/Tosd0/sullyos-workers/blob/main/amsg/worker.bundle.js>

文件上方那排按鈕裡，**Raw** 右邊那個「兩個方塊疊在一起」的圖標就是複製，點它，整份代碼就進剪貼板了。

### D · 貼進 Worker

1. 回到剛建好的 Worker 頁面，點右上角 **Edit code**
2. 編輯器裡打開的是一個 `worker.js`，在代碼區裡點一下，全選（Cmd / Ctrl + A）刪掉
3. 粘貼剛才複製的代碼
4. 點右上角的 **Deploy**

### E · 補上數據庫和定時器

跟著六步裝的話，數據庫綁定和「每分鐘檢查一次」的定時觸發器寫在倉庫的配置文件裡、會自動帶上。手動貼代碼沒有那個文件，這兩樣要自己加。

**數據庫綁定**：Worker 頁面頂部 **Bindings** → **Add binding** → 左邊列表選 **D1 database** → **Add Binding**，然後：

| 位置 | 填什麼 |
|------|--------|
| Variable name | `DB`（就這兩個字母，別改） |
| D1 database | 下拉選 A 步建的那個庫 |

再點 **Add Binding**。加好後表格裡會出現一行 `D1 database / DB / 你的庫名`。

**定時觸發器**：Worker 頁面 **Settings** → 往下找 **Trigger events** → **Add** → 選 **Cron triggers**，然後：

- **Schedule** 那欄：Execute Worker every → 單位選 **Minute(s)**，數字填 `1`
- 也可以切到 **Cron expression** 直接填 `* * * * *`，一個意思

點 **Add**。加好後 Trigger events 表格裡會出現一條 `Cron / scheduled() / * * * * *`。

這兩條加完，回[第四步](#第四步--填鑰匙secrets)填鑰匙。

> 這樣建出來的 Worker，日誌默認就是開的——出問題直接去頂部 **Observability** 標籤看，不用再去打開什麼開關。

### 這條路以後怎麼更新

上游發了新版本之後，重做 C、D 兩步：複製新代碼 → **Edit code** → 全選替換 → **Deploy**。

數據庫綁定、定時觸發器、填過的鑰匙都不會跟著丟，換掉的只有代碼。
