# Soren 路線圖（2026-09-23 定案）

這份記的是 2026-09-23 會議後定下來的方向、每一項的設計決定，以及開發順序。接手任何一項之前先看這份，不用回頭翻對話。

> **狀態欄**隨進度更新。「已完成」的項目寫上對應 PR。

## 大方向

- **以 Soren 為主**。之後不再定期跟進上游 SullyOS；上游有重大更新時會第一時間收到通知，再個別評估要不要整合。每週自動同步的排程已經關掉（`.github/workflows/sync-upstream.yml` 只留手動觸發）。注意 GitHub 的排程只讀**預設分支 `master`** 上的 workflow 檔，所以這個改動要到 `master` 上才真的生效，或直接在 Actions 頁面把這個 workflow 停用。
- **全部轉繁體**，包含給 AI 的提示詞。角色說話會跟著偏繁體，這是預期結果；想要別的樣子由用戶自己在人設裡調。
- 分支流程：在 `claude/*` 工作分支開發 → PR → squash merge 進 `dev`。**每次合併完都要把工作分支重新對齊 `dev`**（squash 之後舊 commit 不在 `dev` 的歷史裡，不對齊的話下一個 PR 會出現假衝突）。

## 上游個別整合紀錄

不跟上游之後，個別搬過來的上游改動記在這裡。搬法：上游那個 commit 的前後兩版都先用轉繁體同一套規則（OpenCC s2tw + 賬→帳、臺→台）轉好，再三方合併進我們的檔案；新檔直接轉繁體。

- **主動消息 2.0「主動頻率」**（上游 `d486bebb`，2026-09-22，#28）：七項按角色設的上限（連發、間隔、每日上限、重複消息沒回就停、同時排幾條、角色能不能自排重複／到點必發），面板在「主動消息 2.0 →主動頻率」，說明見 [`docs/amsg2-pacing-limits.md`](../docs/amsg2-pacing-limits.md)。三方合併零衝突。同時把 `AMSG_BUNDLE_VERSION` 對齊上游的 `2026-09-22`。
  - （當時）**Worker 不是從這個倉庫部署的**：用戶的 Worker 來自上游作者的 `Tosd0/sullyos-workers`，「更新 Worker」也從那邊拉 bundle。所以這邊 `worker/amsg/src` 的改動送不到用戶那台 Worker；只有前端和 Worker 約定好的格式（fire_pack、limits、任務 metadata）要跟上游對齊。`AMSG_BUNDLE_VERSION` 必須等於上游 bundle 的版本，不然設定頁會一直顯示「有更新」。
  - 跟雲端延遲回覆的交集：延遲回覆借的是一次性定時任務的殼，Worker 分不出它是回覆，所以會算進「今天 TA 已主動找你 N 次」，設了每日上限時也可能被跳過。被跳過時 Worker 會留一筆 `last_skip`，本地過點檢查讀到是這條就自己補回（`resolveOverdueCloudDelayedReplies`）。（已由 Soren 自己的 Worker 處理，見下方「Soren 自己的 Worker」。）
  - **上游 Worker 會剝掉它不認得的標籤**（2026-09-24 查到）：Worker 用 `utils/sanitize.ts` 的 `sanitizeIntoSegments` 切推播段落，裡面的 `stripBusinessTagsForNotification` 會把所有 `[[ACTION:…]]` 連原文一起剝掉，只有分類器認得的副作用標籤會改走 directives 通道送到客戶端。所以雲端生成的回覆裡，發照片（`SEND_PHOTO`）和 Soren 自己加的 `RELATIONSHIP`、`NO_REPLY`、`DATE_INVITE`、`CALL` 都到不了客戶端。本機生成的回覆不受影響。
  - **決定：自己維護 Worker（2026-09-24，Liora 拍板）**。SorenOS 出自己的 Worker bundle，把上面這幾個標籤加進分類器的 directives（或放行給客戶端），設定頁的部署連結與自動更新改指向自己的倉庫；之後上游 Worker 的更新由我們手動合。用戶要手動重新部署一次。順便處理：延遲回覆不算進每日主動次數。
  - 當時沒搬的「雲端資料清點」與 amsg-server 升級，已在下一條補上。
- **補齊上游主動消息 2.0 的其餘更新**（#32；上游 `e53907bf` 本地清了雲端跟上的收尾、`6b2975d0` 雲端資料清點、`dc22235d`／`95a7abbc` amsg-server 升到 next.29／next.30）：同一套轉繁體三方合併，衝突處保留 Soren 的每聊天身份變數與簡體統計事件名；`pnpm add` 升到 `@rei-standard/amsg-server@2.6.0-next.30`。這樣 Soren 自己的 Worker 不會比用戶原本跑的上游版舊。

## Soren 自己的 Worker

（#32）

- **從哪裡部署**：一鍵部署（`utils/cfProvision.ts`）和「更新 Worker」（`worker/amsg/src/selfUpdate.ts`）都改成拉 SorenOS 倉庫 **dev 分支**的 `worker/amsg/worker.bundle.js` 與同目錄的 `wrangler.toml`（raw.githubusercontent.com，倉庫是公開的）。兩處網址要一起改。
- **所以 `worker/amsg/worker.bundle.js` 現在是真的會被部署的檔案**：改了 `worker/amsg/src` 或它引用的 utils，要 `pnpm build:workers` 重打包並一起提交，別再還原它。合進 dev 之後，用戶按「更新 Worker」或重跑一鍵部署才會拿到。
- **版本號** `AMSG_BUNDLE_VERSION` 從 `2026-09-24` 起是 Soren 自己的版本（不再對齊上游）；Worker 有「不更新就用不上」的改動時往前推。
- **從上游版換成 Soren 版**：上游版的「更新 Worker」拉的是上游的代碼，換不過來。要用**同一枚 Cloudflare Token 再按一次一鍵部署**：它會沿用現有的金鑰（Master Key、VAPID、Server Token）和同名資料庫，在原本那台上覆蓋，不用重新配對。之後的更新按「更新 Worker」即可。
- **手動部署路線**（fork `sullyos-workers`、部署按鈕）仍指向上游，裝的是上游版；設定頁那一段加了提示，建議改用一鍵部署。
- **Soren 在 Worker 裡改了什麼**：
  - 分類器（`worker/amsg/src/classifier.ts`）加了 `soren_tag` 直通指令：`SEND_PHOTO`、`RELATIONSHIP`、`NO_REPLY`、`DATE_INVITE`、`CALL`（含各自的別名與全形標點，`SOREN_PASSTHROUGH_TAG_RE`）整段原樣隨推播送回客戶端，客戶端 `reconstructDirectiveTags` 拼回原標籤，交給跟本機生成同一份的後處理。雲端回覆裡的發照片會落佔位卡、在手機上生成（收件箱那條路現在也帶上 `imageGenConfig`）。
  - 雲端延遲回覆的任務帶 `metadata.amsgDelayedReply`，Worker 把它當回覆（`isReplyLikeFire`）：不算每日主動次數、不受每日上限擋、不佔連發額度。
- 順手修正：已讀不回標籤的自動回覆內容帶一層中括號（「[會議中] 稍後回」）時，客戶端和 Worker 都認得。

## 開發順序

| # | 項目 | 狀態 |
|---|---|---|
| 1 | 時光契約「讓 TA 記住這一天」注入聊天 | 已完成（#21） |
| 2 | 全部轉繁體（單獨一個 PR） | 已完成（#22） |
| 3 | 個人檔案改版 + 朋友圈互動設定頁 | 已完成（#23） |
| 4 | 聊天設置改全螢幕 | 進行中（第一批：頁面＋Relationship，#24；第二批：已讀不回，#25；第三批：延遲自動回覆，#26；雲端延遲回覆，#27；第四批：線下邀請＋動作描寫，#29；第五批：角色主動打電話，#30；最後一批雙向拉黑＋臨時會話：設計見 [`plans/block-temp-chat-design.md`](./block-temp-chat-design.md)，拉黑本身 #42，臨時會話待做） |
| 5 | NPC：群聊（含旁觀、代為發言）+ 輕量記憶 | 已完成（#34）：A 群聊 + B 輕量記憶；發文／點讚／留言留給第 6 項 |
| 6 | 單一貼文池（先出設計文件） | 進行中（設計文件已定案：[`plans/moments-pool-design.md`](./moments-pool-design.md)；第一批：池子＋兩個入口＋Dock 朋友圈＋查手機 Memo，#36；第二批：自動發文與互動＋私聊裡的最近朋友圈，#40） |
| 7 | 生圖補生成（路線一） | 本機這段：照片佔位卡＋補生成，#31；雲端那段：Soren 自己的 Worker（待用戶重新部署後驗證） |

## 各項設計決定

### 1. 時光契約注入

照「生活紀錄」的做法，在 `ChatPrompts.buildSystemPromptParts` 裡組一段注入，不去動 `ContextBuilder.buildCoreContext` 的 60 多個呼叫點。邏輯在 `utils/anniversary.ts` 的 `buildAnniversaryInjection`（純函數，有單測）：

- 只挑開了「讓 TA 記住這一天」、關聯對象包含這個角色的紀念日，按角色當地日期算。
- 聊天：當天起往後 3 天內的都帶上，用「今天／明天／N 天後」的說法，附上第幾年。
- 主動消息 2.0 打包：模板是先打包、到點才渲染，相對說法會過期，所以只列絕對日期、窗口放寬到 7 天，讓角色對照到點時的當前時間自己判斷。
- 每天都在變，放在易變段（`volatileState`），不弄髒穩定段的快取。

### 2. 轉繁體

腳本轉換 + 排除清單 + 逐一檢查。要特別注意的三類：

- 直接比對原始碼字串的測試，要跟著改。
- 比對角色輸出中文關鍵字的解析（例如改日程的中文別名），轉完後簡繁兩種寫法都要認。
- 舊用戶資料裡存的簡體預設值（例如預設分類名），比對時不能因此失配。

識別字、儲存鍵、資料庫名稱一律不動。

落地實況：

- OpenCC `s2tw`，詞彙表補「賬→帳」「臺→台」；OpenCC 斷詞會誤轉（只→隻、发→髮、历→曆、回→迴等），轉完逐條修過。
- 保持簡體不轉的：統計事件名與屬性值（`utils/analytics.ts`、`utils/analyticsSnapshot.ts`、SAR 功能標籤、收件箱失敗段名）、更新公告與歷史 changelog、pngShare 格式 ID、Live2D 內建模型的表情 ID（舊存檔引用它）、`AMSG2_INSTANT_STUB_TEMPLATE` 哨兵。
- 簡繁都要認的比對統一走 `utils/scriptKey.ts`：`includesAnyScript` / `equalsAnyScript` / `lookupAnyScript` / `anyScriptRegexSource`，純 TS，worker 也能用。**之後新寫的「拿 AI 輸出／用戶輸入／舊存檔跟中文關鍵字比」都用它**，別再只寫一種寫法。
- 正則字面量裡的中文已改成 `[简繁]` 字元類；單字（例如「周」）OpenCC 不轉，要自己補「週」。

### 3. 個人檔案改版

- Chat 的「主頁」直接導到「個人檔案」，原本的主頁頁面不留；銀行（Real Balance）搬進個人檔案。
- 「分角色身份設定」「群聊身份設定」「分角色聊天頭像」三塊收進一個分頁，點了再開。
- 「我的檔案」「生活紀錄」移到最底下改成 Tab bar；「生理期、藥盒、記帳與鍛鍊…」那段說明移進生活紀錄。
- 身份卡移到 header（頭像＋名字，右邊下拉選身份卡、新增身份）。這個 header 也用在 Chat 的四個分頁（消息、聯絡人、動態、主頁），聊天內頁不用。
  - 注意：這裡切的是**全域預設身份**；已經分角色／分群指定過身份的聊天不會跟著換，UI 要讓人看得懂。
- **朋友圈互動**設定頁放在個人檔案：誰可以發帖（角色跟 NPC 在同一份清單）、發帖／評論／點讚頻率。這是「用戶自己的朋友圈」的設定；每個角色自己的朋友圈（角色視角）在「查手機 → 軌跡 → Moments」。

落地實況：

- 個人檔案本體是 `components/user/UserProfileHome.tsx`，Chat「主頁」分頁和桌面「檔案」App（`apps/UserApp.tsx`）共用；頁首身份切換是 `components/user/IdentitySwitcher.tsx`，身份卡編輯器拆成 `UserPersonaEditor.tsx`。
- 朋友圈互動設定存在 `userProfile.momentsSettings`，讀取一律走 `utils/momentsSettings.ts` 的 `normalizeMomentsSettings()`；判斷某個角色／NPC 會不會自動發帖用 `canAutoPost()`。「自動發帖」總開關預設關。第 6 項第二批（`utils/momentsAutoRuntime.ts`）照這份跑：總開關只管自動發文；看到新貼文的按讚、留言照機率走。
- 發帖清單存「關掉的」id，新加的角色預設可以發（但總開關關著時誰都不發）。

### 4. 聊天設置改全螢幕

從彈窗改成全螢幕頁。先做頁面本身、Relationship 一排（暱稱、稱呼、雙方認為的關係、允許角色自主改關係——需要一個新的動作標籤）、「我們已相識 XX 天」；Scenario 那些開關分批上：

- 已讀不回（日程命中勿擾，或落在用戶設定的不回訊時段）
- 延遲自動回覆：現有的自動回覆是全域開關、固定 2 秒、頁面開著才觸發。要升級成**每個角色各自**、等多久看日程（這時段在忙什麼）、情緒、人設，在本機算，不需要後端。設定樣子參考 CsyPhone 的「自律代理」（`apps/settings/AgentSettings.tsx`：間隔範圍、冷卻、每日上限、基礎機率），不需要一致。
- 允許角色主動打電話／視訊、自動線下邀請、線上模式動作描寫
- 雙向拉黑 + 臨時會話（最複雜，放最後）

落地實況（第一批，#24）：

- 全螢幕頁 `components/chat/ChatSettingsPage.tsx` 取代原本的「聊天設置」彈窗：頁首返回（不存）／完成（存），兩人頭像、「我們已相識 N 天」（點開自定義起點，沒設時從第一則私聊訊息算），Relationship 一排，下面接原有的設定分組。
- 角色欄位：`chatNickname`（聊天頁頂部與 Chat 消息列表顯示）、`userNickname`、`userViewRelationship`、`charViewRelationship`、`allowCharChangeRelationship`、`acquaintanceStartDate`。
- 提示詞：稱呼與關係進穩定段；相識天數進易變段（主動消息打包只給起點日期）。邏輯在 `utils/chatRelationship.ts`（有單測）。
- 角色自主改關係：`[[ACTION:RELATIONSHIP|新關係]]`，在 `applyAssistantPostProcessing` 第一步剝掉（跟日程修改同一處），開了允許才寫系統提示並發 `CHAR_RELATIONSHIP_CHANGE_EVENT`，由 OSContext 寫回角色。雲端（主動消息 2.0）生成的回覆：上游 Worker 會把這個標籤剝掉；換成 Soren 自己的 Worker 後以 `soren_tag` 直通送回（見「Soren 自己的 Worker」）。
- Scenario 開關分批做，第二批是「已讀不回」。

落地實況（第二批：已讀不回，#25）：

- 設定存在角色的 `readNoReply`（`ReadNoReplySettings`）：總開關、由角色決定、三種狀態的自動回覆文字、不回訊時段（星期幾＋起訖，可跨夜）、AI 生成自動回覆。介面是 `components/chat/ReadNoReplySettings.tsx`。
- 判斷邏輯在 `utils/readNoReply.ts`（純函數，有單測）：日程沒有勿擾欄位，忙碌／睡覺從當前時段的活動名、描述、emoji 判斷（開會、上課、睡覺…，簡繁都認，排除睡前、睡醒、不忙、幫忙）；用戶設的不回訊時段一律強制，日程判定的忙碌／睡覺在「由角色決定」開著時交給角色。
- 強制：`hooks/useChatAI.ts` 的 `triggerAI` 一開頭攔下，不發主回覆請求，改落自動回覆（`metadata.readNoReply`）＋旁白；同一段忙碌半天內只發一次，之後按回覆只提示「已讀」。「AI 生成自動回覆」走情緒/意識流 API，失敗退回固定文字。實作在 `utils/readNoReplyRuntime.ts`。
- 由角色決定：`chatPrompts` 易變段告訴角色它在忙／在睡，想不回就只輸出 `[[ACTION:NO_REPLY]]`（AI 生成時可附 `|自動回覆內容`）；`applyAssistantPostProcessing` 第一步剝掉並落自動回覆＋旁白。
- 已讀不回過之後真的回覆時，易變段補一句「你剛才沒回，現在看到了」。
- 主動消息（角色自己開口）不套用已讀不回。

落地實況（第三批：延遲自動回覆，#26）：

- 設定存在角色的 `delayedReply`（`DelayedReplySettings`：開關、回覆時間最短／最長分鐘），介面是 `components/chat/DelayedReplySettings.tsx`。開了的角色不套用「輸入與發送」的全域 2 秒自動回覆。
- 等多久（`utils/delayedReply.ts` 的 `computeReplyDelayMs`，有單測）：範圍內落在哪一段看日程——睡覺在最後兩成、在忙在後半、空閒在前六成、正聊得起勁（上一則角色訊息在 10 分鐘內）又空閒在前兩成五。
- 會觸發延遲回覆的：文字、圖片、貼圖，以及戳一下（全域 2 秒自動回覆不回戳一下，延遲回覆會）。轉帳、購物卡片這類不觸發。
- 待回清單存 localStorage（每個角色一筆，後面連發的訊息不會把時間往後推）。用戶送出訊息時由 `utils/delayedReplyRuntime.ts` 排好；`triggerAI` 一開始就取消排著的那筆（手動 ⚡、重新生成都算回過了）。
- 到點：OSContext 每 10 秒、切回前台、清單變動時檢查。用戶正看著這個角色的聊天頁 → 發 `DELAYED_REPLY_DUE_EVENT` 讓聊天頁走完整管線；否則走主動消息 1.0 的背景路徑「回覆模式」（提示改成「對方 N 分鐘前傳了訊息，你現在才看到」、用角色的對話模型、不看主動消息開關）。App 關掉期間過了點的，重新打開時補回。
- 背景回覆模式也處理已讀不回：強制的只落自動回覆；由角色決定時認 `NO_REPLY`。順帶這條背景路徑也認 `RELATIONSHIP` 標籤（它不經過 `applyAssistantPostProcessing`）。
- 開了主動消息 2.0 的角色：見下面「落地實況（第三批續：雲端延遲回覆）」。

落地實況（第三批續：雲端延遲回覆，#27）：

- 對開了主動消息 2.0、也配好 Worker 的角色，用戶送出訊息、排好待回之後再交一條**一次性 prompted 任務**給雲端（`utils/delayedReplyCloud.ts` 的 `handoffDelayedReplyToCloud`），時間是本地 dueAt 再加一分鐘。App 關著或切到背景時由 Worker 生成、推播回來；回覆落進聊天時（`activeMsgRuntime` 認任務 uuid）銷掉本地那筆。
- 借的是角色自排定時消息那條路（`ActiveMsgClient.scheduleCharacterTask`，新加 `task.subtype` / `task.instruction` 兩個可選欄位），但：
  - `messageSubtype = 'delayed-reply'`（`AMSG_DELAYED_REPLY_SUBTYPE`），面板對帳時擋在任務清單外，不佔連發額度；
  - 「本次任務」指令整段換成「這次不是主動找對方，你現在才看到訊息，回他；如果其實已經回過就什麼都不要輸出」（`buildCloudDelayedReplyInstruction`）；
  - `expirePolicy = 'force'`，用戶正開著聊天也不會被「在場就別打擾」的閘攔掉。
- 雲端的 fire_pack 是排任務時打的包；等回覆期間用戶又傳的訊息，靠 `markAmsgStateDirty` 補傳（`amsgStateSync` 那道門除了「有 AI 任務」也認「有交給雲端的待回」）。
- 本地與雲端去重：
  - 頁面看得見、而且離雲端那條還有 20 秒以上 → 本地照舊到點回，順手取消雲端那條；
  - 頁面在背景 → 留給雲端推播；
  - 手動回覆、重新生成（`triggerAI` 開頭）、在設定頁關掉延遲自動回覆 → `cancelDelayedReplyEverywhere`，本地和雲端一起作廢；
  - 雲端過點三分鐘還沒收到回覆 → 問雲端任務狀態：還在排隊就等，行沒了算已經發過（推播或補收會送到），失敗了、或 Worker 留了這條的跳過紀錄才由本地補回。角色的 2.0 被關掉（「取消全部」會一起掐掉）時也由本地補。
- 不交雲端、留在本地照舊的情形：角色沒開 2.0、沒配 Worker、離到點不到兩分半（服務端要求至少提前一分鐘排）、到點那一刻會觸發已讀不回（要看當下日程判斷，雲端做不了）、角色待觸發任務已滿 5 條，或排程失敗。
- 不需要重新部署 Worker：只用到既有的一次性任務與 `amsgTaskInstruction`。

落地實況（第四批：自動線下邀請＋線上模式動作描寫，#29）：

- 兩個開關存在角色上：`dateInvite`、`onlineActions`，都在聊天設定頁的 Scenario 區。
- **線上模式動作描寫**：`chatPrompts` 的「聊天 App 行為規範」第一條原本寫死「不要輸出你的行為」；開了之後換成「可以偶爾用全形括號帶一點你螢幕前的神態或小動作，一則最多一處、一句以內，不寫旁白、不寫對方、不寫面對面的互動」。從通話／見面切回聊天的模式提示同步放寬。只動提示詞，雲端打包用的是同一份。
- **自動線下邀請**（`utils/dateInvite.ts`，有單測）：
  - 開關開著，穩定段才教 `[[ACTION:DATE_INVITE|地點|想一起做什麼]]`（也認「約見面」「見面邀約」等別名和全形標點）。
  - 後處理（`applyAssistantPostProcessing` 第一步和二輪後）一律剝掉標籤，開著才在這一輪所有話的後面落一張 `date_invite` 卡（`metadata.dateInvite`：地點、事由、狀態），一輪只落一張。主動消息 1.0 的背景路徑（含延遲回覆）同樣處理。2.0 雲端生成的回覆：上游 Worker 會剝掉這個標籤，Soren 自己的 Worker 會直通送回。
  - 卡片（`MessageItem` 的 `DateInviteCard`）：「赴約」→ 狀態記成已赴約、落一行旁白、直接進見面（`openDateWithChar`）；「婉拒」→ 記成已婉拒、落旁白。見面開場讀得到聊天記錄裡這張邀請。
  - 歷史和歸檔裡渲染成 `[[記錄:DATE_INVITE|from=char|place=…|plan=…|status=…]]`，跟轉帳同一套記錄形態；模型照抄只會被 sanitize 剝掉，不會多落一張卡。
- 主動打電話／視訊見下面第五批。

落地實況（第五批：允許角色主動打電話／視訊，#30）：

- 開關存在角色的 `charCall`，一個開關，語音或視訊由角色自己挑。邏輯在 `utils/charCall.ts`（有單測）。
- 開著時穩定段才教 `[[ACTION:CALL|voice或video|打來的原因]]`（也認 `VIDEO_CALL`、「打電話」「視訊通話」等別名和全形標點）；提示詞交代偶爾才打、剛打過或對方在忙時不要打、不要在文字裡預告。
- 後處理（聊天頁、主動消息 1.0 背景路徑含延遲回覆）一律剝掉標籤（2.0 雲端生成的回覆：上游 Worker 會剝掉這個標籤，Soren 自己的 Worker 會直通送回）；開著、又過了**一小時冷卻**（`localStorage` 記每個角色最後一次打來的時刻，不管接沒接都算）才在這一輪話後面落一張 `char_call` 來電卡（`metadata.charCall`：模式、原因、狀態、時刻）。一輪只打一通。
- 響不響：回覆是剛生成的（兩分鐘內）、頁面又看得見 → 卡片記「響鈴中」並發 `INCOMING_CHAR_CALL_EVENT`；否則（補收的舊回覆、背景裡落地）直接記**未接**。
- 全域來電畫面 `components/IncomingCallOverlay.tsx`（掛在 PhoneShell，鎖屏時不掛）：
  - 正在通話或有掛起的通話、已經有一通在響 → 直接記未接；
  - 否則全螢幕響 30 秒：盡量震動＋用 WebAudio 放鈴聲（瀏覽器沒被點過時會被擋，畫面照樣跳）；
  - 接聽 → 記已接聽，`openCallWithChar` 跳過選人頁直接接通，角色先開口（不看「角色主動接話」偏好），開場指令是 `buildIncomingCallGreeting`：這通是你打的、你打來是因為……；
  - 拒接 → 記已拒接並落一行旁白；30 秒沒接 → 記未接。
  - 響到一半重新整理：卡片上的「響鈴中」過了時限一律顯示成未接（`effectiveCallStatus`），歷史記錄也這樣算。
- `OSContext` 新增 `callAutoStart` / `openCallWithChar` / `consumeCallAutoStart`（跟見面的自動進入同一個做法）；`CallApp` 接到後先把角色和模式換好，再走 `requestSelectedCall`（視訊第一次用仍會先跳設定導覽）。
- 來電卡（`MessageItem` 的 `CharCallCard`）：顯示語音／視訊、原因、狀態；未接或已拒接的可以「回撥」，照一般流程打回去（這次是用戶打的）。
- 歷史和歸檔渲染成 `[[記錄:CALL|from=char|mode=…|reason=…|status=…]]`。
- 冷卻中（易變段，`buildCharCallCooldownNote`）告訴角色「你 N 分鐘前才打過、M 分鐘內打不出去」，別寫來電標籤也別說「我打給你了」；對方要你打就說晚點打或請對方打來。實測時角色被要求再打一次、嘴上說打了卻沒響，才補上這條。
- 已知限制：2.0 雲端生成的回覆靠推播送達，推播文字是 Worker 從正文生成的，看不到來電卡，只看得到那一輪的話；打開 App 後才看到未接來電卡。

落地實況（最後一批之一：雙向拉黑，設計見 [`plans/block-temp-chat-design.md`](./block-temp-chat-design.md)）：

- 狀態存在角色的 `chatBlock`（誰拉黑誰、何時、角色的原因、下次考慮解除的時刻），解除過的收進 `chatBlockLog`；純邏輯在 `utils/chatBlock.ts`（有單測）。被拒收的訊息不另外存：用戶訊息時間落在角色拉黑用戶的期間就是。
- 擋生成的地方：`triggerAI` 開頭（⚡、延遲回覆到點、自動回覆都走它）、全域自動回覆與延遲回覆排程、`runProactive`（主動消息 1.0 與背景回覆）、雲端 fire_pack 的 `chatBlocked`（Soren Worker 跳過並記 `chat-blocked`）加客戶端收件兜底、朋友圈（拉黑不算朋友、連公開貼文都看不到、不自動發）。
- 角色拉黑：`[[ACTION:BLOCK_USER|原因]]`，聊天設定開了「允許角色拉黑你」才生效；後處理與背景路徑都剝標籤、發 `CHAT_BLOCK_CHANGE_EVENT` 由 OSContext 寫回。冷靜期（消氣快／一般／記仇）到了由 OSContext 每分鐘那一輪問一次（`utils/chatBlockRuntime.ts`），不解除隔天再問，失敗一小時後再試。
- 用戶拉黑、解除、強制解除都在聊天設定頁最下面，當下生效並落系統提示；拉黑中輸入框換成「解除拉黑」那條。

### 5. NPC：走 A + B

NPC 維持**獨立的資料表**，不併進角色清單。理由：全專案有 100 多個檔案會掃整份角色清單，其中包含日程、情緒、主動消息、記憶宮殿、彼方、節日活動等背景系統；NPC 併進去就會被當主角跑這些東西。NPC 的定位是推動劇情的配角，不跟用戶一對一私聊，用不到完整角色功能。

- **A. 群聊**：群成員可以放 NPC。每個群可設定用戶「參加」或「旁觀」；旁觀時成員名單裡沒有用戶，角色們也不知道用戶在。旁觀底部欄：選群裡某個成員**代替他發言**（推劇情用）、劇情方向、▶ 繼續對話。代打的訊息算那個成員說的（進記憶），介面上加小標記讓用戶分得出來。這些群就放在 Chat 的群聊列表。
- **B. 輕量記憶**：NPC 自己的一份記憶，從它參與過的群聊、朋友圈互動、查手機對話自動摘要，也可以在 NPC 編輯頁手動改；輪到它說話／發文時帶進 prompt。不接記憶宮殿。
- **查手機裡 NPC 跟角色私聊**：沿用現有「查手機聯絡人綁定 NPC 生成對話」，接上 B 的記憶。
- **發文／點讚／留言**：在第 6 項接上，NPC 是貼文池的一種作者。

**落地實況（#34）**

- **NPC 入群不進 `members`**：放在 `GroupProfile.npcMemberIds`。`members` 有十幾處背景邏輯在讀（話題盒卡片發進成員私聊、主動消息打髒、私聊 prompt 的「近期群聊」、記憶宮殿…），全都假設是角色；NPC 只在群聊生成這條路上被當成員。禁言沿用 `mutedMemberIds`。群設定「NPC 成員」可以加、移除、禁言，沒有人數下限。
- **生成**（`utils/groupChat/npcMembers.ts`）：導演模式在角色檔案塊後面接 NPC 檔案塊（設定、世界觀、跟用戶／在場成員的關係、掛載世界書按關鍵字觸發、輕量記憶），導演指令多一段「NPC 成員」說明；輪詢模式 NPC 排在角色們後面輪流，用 NPC 自己配的 API（`resolveNpcApi`，沒配用群聊那組），指令換成 NPC 版（不教 PRIVATE／退群、跟用戶的關係以檔案為準）。派發層 `npcIds`：NPC 寫了 PRIVATE 直接丟掉。
- **名字**：群歷史、成員時間線、引用、話題盒整理、角色私聊裡的「近期群聊」都認得 NPC 的名字（`buildSpeakerDirectory`；OSContext 的名字註冊表也登記 NPC）。
- **旁觀 = 原本的「隱身圍觀」**（`userLurkMode`），群設定裡改叫「旁觀（我不在這個群裡）」。開著時輸入框上面多一條旁觀欄：點成員頭像選「代打」，輸入框發出的就存成那位成員說的（`role: assistant`、`metadata.puppeted`，進群歷史、時間線、記憶），介面上名字旁有「代打」小標；「劇情方向」只管下一輪（`buildPlotDirectionNote`，按 ▶ 後清掉）；▶ 讓大家繼續聊。沒選代打時發的消息照舊只留在用戶螢幕上。
- **輕量記憶**（`utils/npcMemory.ts`、`utils/npcMemoryRuntime.ts`）：`NPCProfile.memory`，NPC 第一人稱條列，整段重寫、約 800 字上限。
  - 群聊：每輪生成完，群裡的 NPC 在水位（`memoryGroupMarks[groupId]`）之後攢到 30 條就整理一次；旁觀的群跳過用戶的話。NPC 編輯頁「從群聊整理」有新消息就整理。
  - 查手機：綁定了 NPC 的聯繫人，生成對話前把記憶折進備註，生成完把這段新對話（轉成 NPC 視角）併進記憶。
  - 帶進 prompt 的地方：群聊 NPC 檔案塊、NPC 客串一句、查手機 NPC 對話、見面劇情的客串 NPC。
  - NPC 編輯頁「記憶」可以直接改。

### 6. 單一貼文池

現在是兩個池子：Chat「動態」連到舊的沖浪 App（SocialApp，隨機生成），軌跡 Moments 每個角色各存一份。改成：

- 一個貼文池，用戶、角色、NPC 發的都落在這裡。
- 每篇貼文帶可見範圍：預設朋友可見；另有公開、指定給某些人（可多選）。
- 按讚、留言是池子裡的資料，記錄是誰做的。
- 看的人不同看到的不同：Chat 動態用用戶視角，查手機 Moments 用該角色視角。朋友關係：用戶跟所有角色預設是朋友；角色之間看查手機聯絡人（`friend`）；NPC 看它的關係清單。
- 軌跡現有的 Moments 貼文搬進貼文池。
- 舊的沖浪動態（SocialApp）先不動，當獨立 App 留著。
- 後台自動發文會一直花 API，頻率受第 3 項的朋友圈互動設定控制。

開工前先寫一份獨立的設計文件（資料結構、可見範圍演算法、搬遷方式），確認後再動。設計文件：[`plans/moments-pool-design.md`](./moments-pool-design.md)。

### 7. 生圖補生成（路線一）

- Worker 的分類器認得 `[[ACTION:SEND_PHOTO|描述]]`，轉成指令跟推送一起送到（目前它不在清單裡，雲端回覆裡的發照片會直接消失）。
- 聊天裡先出現「照片生成中」的佔位卡，用戶回到 App 時在本機生成並填入；鎖臉照常生效（參考圖本來就在本機）。
- 同一套機制也涵蓋本機聊天：生圖途中切走導致失敗的，回來會補生成。
- 不走「全部在雲端生」：那需要把生圖金鑰和參考圖上傳雲端，還要每個用戶另外綁 R2 儲存空間（Worker 目前只有 D1，放不下圖片），換來的只是回來時少等幾十秒。

落地實況（本機這段，#31）：

- 角色要發照片（`[[ACTION:SEND_PHOTO|描述]]`，`chatParser` 執行）時先落一張「照片生成中」的佔位卡（type `photo_pending`，`metadata.pendingPhoto`：描述、試過幾次），記進 localStorage 的待補清單，再去生成；成了就用 `DB.replaceMessageFields` 把這一則換成 `image`（跟以前一樣帶 `aiGenerated`、`imagePrompt`，也存進相冊）。邏輯在 `utils/pendingPhoto.ts`（有單測）。
- 生成途中切走、失敗：佔位卡留著顯示「照片生成中斷，回到 App 時會自動再試」，只彈一個提示。OSContext 在啟動、切回前台、每分鐘（頁面看得見時）把待補清單逐張補上，一張一張來不併發。
- 自動試了 4 次還不行就停下，卡片顯示「照片沒能生成」和「重試」按鈕。
- 佔位卡一落地就推一次聊天頁重讀（`active-msg-progress`）：聊天頁本來要等整輪後處理跑完才重讀，實測時佔位卡從來沒被看見、照片是直接冒出來的。
- 歷史裡佔位卡渲染成「你發了一張照片（描述），還在傳送中」，角色不會以為自己沒發。
- 雲端那段：Soren 自己的 Worker 把 `SEND_PHOTO` 以 `soren_tag` 送回，收件箱後處理落佔位卡、在手機上生成（見「Soren 自己的 Worker」）。

## 零碎修正（#33 起）

- 見面（`DateApp` 的 `callLLM`）和通話（`CallApp` 的 `requestAssistantReply`）改成跟私聊用同一個模型：角色設了專屬「對話模型」（`chatApi`）就用它，沒設才落到全局 API（`resolveCharacterChatApi`）。原本這兩處寫死全局 API，全局那組掛掉時，設了專屬 API 的角色一進見面就生成失敗。（#33）

## 暫時不動

- 軌跡 Backstage（後台生活）：待定，要等 MCP。
- 身份卡分流的其餘畫面（虛構劇場、日記、小屋等仍讀全域身份）。
- 群主實際權限（例如只有群主能改公告、群主不能退群）。
- 主動消息 2.0 的去留：考慮重做，未定。
