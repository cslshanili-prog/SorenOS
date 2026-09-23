# 查手機 · 人際關係系統

> 給「查手機」(`apps/CheckPhone.tsx`) 的聊天能力做的一次大升級：從一次性瞎編 NPC 對話，變成有**聯繫人簿、好感度、真假甄別、真角色之間雙向同步對話、AI 玩 AI 偷窺**的人際關係系統。
> 改這塊邏輯前必讀。

## 一句話

查 A 的手機時，TA 通訊錄裡的人可能是神經鏈接裡**真實存在的角色 B**，也可能是按人設虛構的 **NPC**。真角色之間能揹著用戶私下對話，且對話會在雙方手機裡保持一致。
（AI 玩 AI / 智能體不在本系統內——那塊單獨做一個「智能體 App」。）

## 數據模型（`types.ts`）

通訊錄、完整聊天原文和話題盒都存在角色的 `phoneState` 中，隨完整備份 / 文字備份的 `characters` 分片一起導出與恢復，與 `sendToChat` 開關無關。僅媒體備份不包含聊天文字。真實對話異步完成時，`applyRealConversationToPhoneState` 必須在 `updateCharacter` 的函數式回調裡基於最新狀態合併，避免覆蓋生成期間新增的其他聯繫人和記錄。迴歸見 `utils/phoneConversationBackup.test.ts`。

- `PhoneContact`：聯繫人。`kind: 'real' | 'npc'`；`linkedCharId`（real 時綁定真實角色）；`affinity`（機主對 TA 的好感，**-100..100**，負=反感）；`status: 'friend'|'pending'|'blocked'|'deleted'`。
  - `note`：**機主/用戶手寫的備註**——當「已確立的事實」用，prompt 裡要求嚴格遵守，**不被自動生成覆蓋**（見下）。
  - `learned`：**機主相處中「逐漸瞭解到」的認識**——由對話裡 `[[瞭解:…]]` 累積而來。**和 note 分開**：這是「印象/判斷」，來源是對方在聊天裡自己說的，**未必屬實**（對方可能在編）。
  - `topicBox?: ConvTopic[]`：**聊天話題盒**——這一側第一人稱、帶主觀色彩的「聊天記憶」，每聊滿 100 條濃縮出一條；用作上下文（替代被歸檔的原文）。可長按改/刪。
  - `archivedThru?: number`：**已歸檔原文條數水位線**——`record.detail` 裡這之前的內容不再進上下文（只由話題盒代表），但原文仍保留供用戶查看。
- `ConvTopic`：話題盒一條記憶（`text` 第一人稱總結 / `createdAt` / `span` 濃縮了多少條原文）。
- `PhoneEvidence.contactId?`：聊天記錄歸屬的聯繫人。
- `CharacterProfile.phoneState.contacts?: PhoneContact[]`：機主通訊錄。
- `CharacterProfile.phoneState.allowFictionalContacts?: boolean`：是否允許虛構 NPC（默認 true）。**關掉 = TA 只與神經鏈接裡的真實角色來往**，生成時丟棄所有非真實聯繫人。

## 輸入契約（用戶指定，統一用於所有生成）

每次為「指定關係人 X」生成內容時：

1. `ContextBuilder.buildCoreContext(char, user, true)`
2. 記憶宮殿（若 `memoryPalaceEnabled`）：`injectMemoryPalace(char, recent, /*queryHint*/ X.name, user.name)` —— **query 用對方的人名**。
3. 最近上下文：`loadCharacterContextMessages(char)`，與聊天共用「自適應 / 手動」和用戶起點。自適應讀取水位線後原文；手動可讀取已歸檔的最近 N 條。

## 能力

| 能力 | 說明 | 入口 / 代碼 |
|---|---|---|
| **聯繫人骨架** | 聯繫人模型 + 生成時注入真實角色名單做 **real/npc 甄別** + 通訊錄 UI（好感條 / 備註 / 手動加刪拉黑 / 虛構約束開關）+ 掃描通訊錄 | `CheckPhone.handleGenerate('chat'\|'contacts')`、`renderContactsList` / `renderContactDetail` |
| **虛構約束** | `allowFictionalContacts` 關掉後，生成只取真實角色、丟棄所有 NPC —— TA 只和神經鏈接裡的角色來往 | `CheckPhone.toggleAllowFictional`、`handleGenerate` 的 `fictionRule` |
| **真角色雙向對話** | **雙 LLM**：A 用 A 的 context 發、B 用 **B 自己的 context + 記憶宮殿(query=A 名) + B 的 contextLimit** 回。默認 **1 個往返 = A 發 1 次 + B 回 1 次 = 正好 2 次 LLM 調用**（`rounds` 可調）。好感變化折進各自回覆末尾的 `[[Δ:+N]]`，解析後剝掉，**不再額外調用**。鏡像進 B 的 `records`；**B 私聊僅當 B 自己 `sendToChat !== false`** 才寫。好感 -100..100，跌破 -60 角色自動刪友、升過 +60 自動加回，變動播報進機主私聊 | `utils/relationshipChat.ts:runRealConversation`、`CheckPhone.handleRealConversation` / `commitConversationSide` |
| **虛構 NPC 對話** | 機主按人設腦補出不存在的人，單 LLM 分飾兩角生成聊天腳本（不鏡像、不涉及真實角色） | `utils/relationshipChat.ts:runNpcConversation`、`CheckPhone.handleNpcConversation` |
| **用戶刪好友 → char 知情** | 用戶在查手機裡手動刪好友/拉黑時，往機主私聊落一張 **`phone_card` 關係變動卡片**（`kind:'relationship'`，💔/🚫）：聊天裡渲染成卡片、`content` 又帶進角色上下文，讓角色察覺「是用戶乾的」。角色自身的好感驅動增刪則照常自發發生 | `CheckPhone.handleSetContactStatus`、`MessageItem.tsx` phone_card `relationship` 分支 |
| **真實時間感知** | 當前真實日期/星期/時段/時間統一在 `ContextBuilder.buildCoreContext` 注入，受 `char.timeAwarenessEnabled` 控制（**默認開**）。所有走 buildCoreContext 的路徑（私聊/查手機/人際關係/通話/約會…）都有時間觀念；關掉則全部不注入。同一段裡還跟著一句分寸框定：時間是背景，話題聊到哪兒由對話本身決定（這句話在 `utils/timeFramingNote.ts`，即時對話在雲端補時間時引的是同一份）。跟著一起收的還有另外兩塊會報鐘點的注入：天氣塊的 `includeTime`、日程塊的 `includeClock`，免得關掉之後鍾從旁邊漏出去。主動消息的排程清單不收——那是角色自己排的待辦，看不見就會重複排同一件事 | `utils/context.ts` buildCoreContext「當前時間」塊 |

## 備註 vs 瞭解（兩份不同性質的「認識」）

| | `note` 備註 | `learned` 瞭解 |
|---|---|---|
| 誰寫的 | 用戶/機主**手寫**（`handleSaveNote`） | 角色對話裡**自動產出**（`[[瞭解:…]]`） |
| 性質 | **已確立的事實**，必須遵守 | **印象/判斷**，來源是對方自己說的，**未必屬實** |
| prompt 注入措辭 | 「必須當作真實情況嚴格遵守，不得與之矛盾」 | 「憑相處得來的印象，未必屬實，可作參考別當鐵證」 |
| 會被自動改嗎 | 不會（`upsertContact` 保留已有非空 note） | 會累積（`appendLearned`，去重 + 留最近 8 條） |
| UI | 「備註」卡（可編輯） | 「瞭解」卡（虛線、只讀、可一鍵清空） |

> 想讓角色「認得」某人、按某關係演，寫 **備註**；想看角色在交往裡**自己摸索出的（可能被騙的）認識**，看 **瞭解**。

## 對話裡的內聯指令（寫在回覆末尾，引擎解析後剝掉，不再額外調 LLM）

- `[[Δ:+N]]` —— 這段說完後說話人對對方的**好感變化**，N 為 -20~20 整數；沒變寫 `[[Δ:0]]`。`extract()` 累加並鉗制。
- `[[瞭解:一句話]]` —— 說話人這次**新認識到**的關於對方的事（身份、在意什麼、透露的關鍵信息…）。`extract()`（真人）/ `runNpcConversation`（NPC，從整段輸出裡摳出）解析出來，經 `appendLearned` 寫進**說話人對對方**那條聯繫人的 `learned`。沒有新認識就不寫這行。
  - 真人雙向：A 學到的進「A→B」的 learned，B 學到的進「B→A」的 learned，各記各的。
  - NPC：腦補出的設定也回寫 learned，**讓同一個虛構的人下次保持一致**。

## 動機（讓「主動發消息」事出有因）

A 發起 / NPC 推進的 prompt 裡給了一份**具體動機清單**（好奇這人怎麼會在通訊錄裡、寒暄水聊、求助、打聽/試探身份、報備近況、不滿對峙…），可任選一種或幾種，並要求：**貫徹動機、前後一致**，別「明明自己找上門卻突然卑微討好或反過來陰陽怪氣」。角色被強調為**完整獨立人格**，回應方也基於自身立場（不一味迎合、不無故敵對）。

## 話題盒 · 100 條總結歸檔（上下文壓縮）

真人 A↔B 私聊會越聊越長，原文整段重喂會撐爆上下文。機制：

- **觸發**：每聊滿 `ARCHIVE_EVERY = 100` 條（氣泡/行，非輪），`maybeArchiveConversation` 把待歸檔的那 100 條原文，**A、B 各自第一人稱**濃縮成一條 `ConvTopic`（`summarizeConversation`，各一次 LLM），分別進各自 `topicBox`，`archivedThru += 100`。
- **上下文**：之後餵給 `runRealConversation` 的不再是整段原文，而是 `existingDetail = 近段未歸檔原文`（`record.detail` 在 `archivedThru` 之後的部分）+ `aSummary/bSummary = topicText(該側 topicBox)`。即 **A 拿到「a 的話題盒 + 近段」，B 拿到「b 的話題盒 + 近段」**。
- **原文不丟**：完整腳本仍整段存 `record.detail`（`handleRealConversation` 把歸檔段 `archivedALines` 拼回 `result.aDetail` 再落庫），聊天界面照常翻看；歸檔只影響**進上下文**的部分。
- **鏡像一致**：A 存完整 `aFull` 後 `bFull = flipTranscript(aFull)` 給 B，兩邊原文一致；`archivedThru` 雙方同步推進。
- **用戶可改**：話題盒在資料抽屜「備註」下面，**長按某條記憶 → 改寫 / 刪除**（`topicEdit` + `Modal`）。刪一條 = 角色忘掉那段總結（原文仍在，但不再進上下文）。`topicText` 進上下文時默認只取最近 10 條防膨脹。
- **優雅降級**：不滿 100 條時 `archivedThru=0`、`topicBox` 空 → `existingDetail=整段`、無總結塊，行為與歷史完全一致。
- **NPC 暫未接**：`runNpcConversation` 仍喂整段（單視角），後續可同法接入。

## 真假甄別怎麼做的

生成 `chat` / `contacts` 時，把**神經鏈接裡其他真實角色名單**注進 prompt，要求 LLM 對每個聯繫人輸出 `kind`（real/npc）+ `linkedName`。落庫時再用 `matchRealChar()` 對名字做精確/包含兜底匹配，命中即綁定 `linkedCharId` 並置 `kind:'real'`，防 LLM 漏標。

## 關鍵文件

| 文件 | 職責 |
|---|---|
| `utils/relationshipChat.ts` | 純函數（`normName`/`matchRealChar`/`upsertContact`/`clampAffinity`/`parseTranscript`/`serializeTurns`/`flipTranscript`/`appendLearned`/`topicText`）+ 對話引擎（`runRealConversation` 雙 LLM / `runNpcConversation` 單 LLM / `summarizeConversation` 總結歸檔） |
| `utils/relationshipChat.test.ts` | 純函數單測 |
| `apps/CheckPhone.tsx` | 通訊錄 UI + 全部 handler + 落庫/鏡像 |
| `types.ts` | `PhoneContact`（含 `note` / `learned` / `topicBox` / `archivedThru`）/ `ConvTopic` / `PhoneEvidence.contactId` / `phoneState.contacts` |

## UI 命名

- 該系統在「查手機」首頁的入口卡叫 **「聯繫人」**（佔據原 Message 主卡位）；舊的 Message 一對一聊天已廢棄，收進「聯繫人」頁裡做一個不起眼的「舊版聊天歸檔」入口。內部代碼/上下文裡仍可能出現「人際關係」字樣（語義等價）。

## 對話腳本格式（重要 · 多行不丟/不錯位）

- 腳本統一是「我:/對方:」逐行格式。一條消息可能跨多行（模型連發幾條），**存庫時每一行都補回說話人前綴**（`runRealConversation` 的 `lineify` / `runNpcConversation` 走 `serializeTurns(parseTranscript())`）。
- 解析一律走 `parseTranscript()`：無前綴的續行**繼承上一條說話人**，不會被誤判給對方（修復「A 發的消息 UI 分給 B」）。渲染（`renderChatDetail`/`renderContactDetail`）、翻轉（`flipTranscript`）、續寫回解析都用它，保證無損。
- `upsertContact` 合併時**只覆蓋有值的字段**，且不動已有非空 `note`——掃描通訊錄/對話回填不會把用戶手填的備註抹掉（修復「角色不看備註」）。備註在 prompt 裡以「必須遵守的已確立事實」注入。

## 注意

- `runRealConversation` 續寫**只喂近段未歸檔原文**（`existingDetail=recentDetail`）+ 話題盒總結；`handleRealConversation` 落庫前把歸檔段 `archivedALines` 拼回去，整段替換 `record.detail`（**存的是完整原文**，進上下文的才是壓縮版）。
- `runRealConversation` 同時把好感 `[[Δ]]` / 瞭解 `[[瞭解:]]` 折進各自回覆解析；總結歸檔是**另一步**（`maybeArchiveConversation` 在落庫後按 100 條觸發，單獨 LLM）。
- 鏡像寫入對方 B 用的也是 `updateCharacter(b.id, …)`（函數式合併），不會覆蓋 B 的 simLogs。
- 好感變化由 A/B 各自在回覆末尾用 `[[Δ:+N]]`（-20~20）帶出，`extract()` 解析並剝掉標記 —— 不另開 LLM 調用；模型沒給則 delta=0。`[[瞭解:…]]` 同理（同一次解析裡一起摳出）。
- `learned` 始終以「未必屬實」的措辭注入，**別在別處把它當事實用**；要表達確定事實請走 `note`。
- 角色**自發**的關係變動（好感閾值觸發自動加刪友）會播報「我把 XX 刪了」進機主私聊；**用戶手動**刪/拉黑則落 `role:'system'` 提示讓角色知道是用戶乾的 —— 兩者區分開。
