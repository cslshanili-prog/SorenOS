# AI 助手（幫寫美化、預設，答疑）

> 狀態：第 1 批（答疑）已做，實況見第 9 節；第 2 批（美化 CSS）做到 2a（位置表、讀寫工具、提案卡片、快照還原），實況見第 10 節。第 2 批 Liora 定了：預覽先做白框和氣泡、可以傳圖給 Sore、八處都放捷徑、快照不進備份。Liora 已定：桌面 App＋各處捷徑；寫入前先給你看、按「套用」才寫，寫前留快照可還原；第一版做答疑＋美化 CSS；API 設定裡可選，預設用副 API。名字叫 **Sore**：有點幽默毒舌、隨意、偶爾用 emoji、像朋友聊天、簡短不囉嗦。頭像先用佔位圖。

## 1. 要做什麼

一個內建的小助手，用戶用說的就能：

- **答疑**：怎麼用、設定在哪、為什麼角色不說話／主動消息不來、API 報錯看得懂。
- **美化**：「把聊天頂欄改成奶茶色、加一點蕾絲」→ 助手讀現在的 CSS、寫新的、先預覽，用戶按套用才寫進去。
- 之後的批次：寫預設條目和正則、世界書、桌面小組件。

它是工具，不是角色：不進記憶宮殿、不排主動消息、不跟角色的設定混在一起。

## 2. 參考 FloraOS「小卷」

FloraOS（`lib/mascot-*.ts`、`lib/qa-agent-engine.ts`）：

- 一個常駐助手＋一個答疑 App。工具分「套件」（CSS、圖像、角色卡、世界書、預設、正則、狀態欄、桌面組件、特調），要用哪套才展開那套的工具說明，省 token。
- 原生 function calling 和文字協議兩套都支援；agent 循環由畫面驅動（讀工具自動跑、跑完把結果回給模型）。
- 每個寫入工具都有格式檢查（例如狀態欄契約沒有成對標籤就拒絕）。
- 答疑的知識是一份手寫的產品知識全量放進系統提示詞，專題文件照關鍵詞再附加。

Soren 照這個思路，但：

- **只用文字協議**：很多人用中轉，原生工具支援參差不齊；Soren 角色的動作本來就是文字標籤，解析和容錯有經驗。
- **寫入一律走「提案卡片」**：助手不能直接寫，只能提案；用戶按套用才寫（Liora 定的）。

## 3. 畫面

- **桌面 App「助手」**（名字待定）：一個聊天頁。對話存在本機（新表 `assistant_sessions`，可以開新對話、刪掉舊的）。
- **提案卡片**：助手要改東西時，在對話裡出一張卡片——改哪裡（「聊天白框 · 全域」）、改之前／之後（CSS 給差異或全文、可以展開）、**預覽**（美化類開一個小窗套上看效果）、**套用**、**不要**。套用後卡片變成「已套用 · 還原」。
- **快照**：每次套用前把那個位置原本的內容存一份，跟著那張卡片存在對話裡（`AssistantProposal.snapshot`），「還原」就是寫回去。沒有另開表：卡片在、快照就在；刪掉對話快照也跟著沒了。不進備份。
- **各處捷徑**：白框 CSS 編輯器、氣泡工坊、見面畫面美化、心象卡片設定、交換日記／日程外觀、預設 App（第 2 批起）放一顆「請助手幫忙」：點了打開助手，帶上「我在改哪裡、現在的內容」，助手第一句就知道要做什麼。
- **設定**：助手用哪組 API（預設副 API → 全域）、模型建議（寫 CSS 用聰明一點的）。

## 4. 工具（文字協議）

模型在回覆裡寫：

```
<tool name="讀取CSS">{"location": "chat_chrome_global"}</tool>
```

- **讀的工具**：畫面自動執行，把結果回給模型再讓它接著寫（一輪最多 6 次，超過就停下來請用戶看）。
- **寫的工具**：不執行，變成提案卡片。用戶按套用時才真的寫，寫之前再跑一次格式檢查。
- 解析容錯：標籤沒閉合、JSON 有尾逗號、用了全形引號，照聊天標籤那套兩層容錯；解析不出來就把原文當普通回覆。

### 第 1 批：答疑

- 系統提示詞帶一份**手寫的使用知識**（`utils/assistant/knowledge.ts`）：功能版圖、首次設定、常見問題（從「使用幫助」的 FAQ 搬）、排查方向（角色不說話、主動消息不來、API 401／429／逾時、資料都在本機要備份）。
- 工具：
  - `查看設定概況`：API 有沒有設（不讀 Key，只看有沒有）、模型名、副 API、生圖、語音、主動消息開沒開；給答疑判斷「是不是沒設」。
  - `測試API`：打一次很小的請求，回成功／失敗與錯誤訊息（不回 Key）。
  - `讀說明`：從一份**給用戶看的**說明清單裡挑一篇讀（MCP 教學、主動消息、身份卡、預設 App……），不是開發文件。

### 第 2 批：美化 CSS

位置（每個都有現成的選擇器清單和檢查函式，助手直接用同一份）：

| 位置 id | 是什麼 | 存在哪 | 選擇器／檢查 |
|---|---|---|---|
| `chat_chrome_global` | 聊天白框 · 全域 | `OSTheme.chatChromeCustomCss` | `ChromeCssEditor` 的清單 |
| `chat_chrome_char` | 聊天白框 · 某個角色 | `CharacterProfile.chromeCustomCss` | 同上 |
| `chat_chrome_group` | 聊天白框 · 某個群 | `GroupProfile.chromeCustomCss` | 同上 |
| `bubble_theme` | 氣泡工坊的一個主題 | `ChatTheme.customCss` | 氣泡工坊的規則 |
| `date` | 見面畫面 | 見面外觀 `customCss` | `DATE_CSS_HOOKS`、`scopeDateCss` |
| `thinking_chain` | 心象卡片 | `thinkingChainCustomCss` | `PSYCHE_SELECTOR_REGEX` |
| `journal` | 交換日記 | `JournalAppearance.customCss` | `JOURNAL_CUSTOM_CSS_SELECTORS` |
| `schedule` | 日程 | 日程外觀 `customCss` | `SCHEDULE_CUSTOM_CSS_SELECTORS` |

工具：`讀取CSS`（不給位置＝列出各處有沒有設；給位置＝現在的內容＋可用選擇器＋規範）、`寫CSS`（提案：整段新內容，檢查不過就回錯誤讓它改）、`清除CSS`（提案）。

預覽：美化類的提案卡片可以「預覽」——開一個小窗，用假資料畫出那一頁（白框：一段示範聊天；見面：一段示範故事；心象卡片：一張示範卡），套上新 CSS。

### 之後的批次

- **第 3 批：預設＋正則**：讀預設、改條目、加條目、從內建複製、加正則（ST 格式檢查），寫進預設 App。
- **第 4 批：世界書＋小組件**：世界書條目（照 ST 欄位）、桌面自訂小組件（HTML，`custom_widget_template` 格式、沙盒裡預覽）。

## 5. 系統提示詞

1. 助手是誰（Sore：隨意、有點毒舌、偶爾 emoji、簡短）、它能做什麼、不能做什麼（不能直接寫、不能讀 API Key、不知道就說不知道）。
2. 工具協議與目前展開的工具說明（第一批只有答疑＋CSS）。
3. 答疑知識（第 1 批）。
4. 從捷徑進來時：在哪一頁、要改的位置、現在的內容。

## 6. 隱私與安全

- 不讀、不送 API Key；設定概況只說「有／沒有」。
- 角色資料、聊天內容只在用戶貼給它或從捷徑帶進來時才進對話，助手不會自己去翻。
- 寫入只走提案卡片；CSS 一律過該位置原本的限定作用域檢查（跟手動編輯一樣），不允許寫全域選擇器。

## 7. 分批

| 批 | 內容 |
|---|---|
| **1** | 助手 App（聊天頁、對話存本機、API 設定、文字協議與工具循環、提案卡片＋快照還原的骨架）＋答疑（知識、設定概況、測試 API、讀說明） |
| **2** | 美化 CSS（八個位置的讀／寫／清除、預覽、各處「請助手幫忙」捷徑） |
| 3 | 預設＋正則 |
| 4 | 世界書＋小組件 |

## 8. Sore 的個性

- 像朋友聊天：隨意、有點毒舌但不刻薄，偶爾一個 emoji，簡短不囉嗦；講完重點就停。
- 跟內建角色 Sully（上游帶來的測試角色卡，純聊天）分開：Sore 不是角色，不進角色清單、不進記憶宮殿、不主動找人。
- 不知道就說不知道，不編設定位置；要改東西只出提案卡片。
- 頭像：先佔位，Liora 之後給圖再換。

## 9. 實況：第 1 批（答疑）

- 桌面 App「Sore」（`apps/AssistantApp.tsx`，`AppID.Assistant`）：聊天、對話列表（新對話、刪除）、設定（用哪組 API）。空的時候有幾個建議問題可以點。
- 對話存在 `assistant_sessions` 表（DB v80，`DB.getAssistantSessions` / `saveAssistantSession` / `deleteAssistantSession`）；只在這台裝置，**不進備份**（答疑紀錄沒什麼好留的；之後的寫前快照要不要進備份，第 2 批再定），也不進記憶宮殿。
- 用哪組 API：`utils/assistant/api.ts`，偏好存這台裝置的 localStorage（`soren_assistant_prefs_v1`）。自動＝副 API（記憶宮殿的 lightLLM）有設就用，沒設用全域；也可以選全域或 API 庫的某一組；選的那組沒填好會往下退。
- 引擎：`utils/assistant/engine.ts` 的 `runSoreTurn`。文字協議（`utils/assistant/protocol.ts`）：模型寫 `<tool name="X">{json}</tool>`，結果用 `<tool_result>` 當 user 回給它；一輪最多叫 6 次工具，超過就叫它先停下來講目前查到的。容錯：標籤沒閉合、JSON 尾逗號、全形引號、少一個 `}` 都收。
- 工具（`utils/assistant/tools.ts`，第 1 批都是讀，全部自動跑）：查看設定概況（只回有沒有設、模型名，Key 一律只說有／沒有）、測試API（真的打一次很小的請求，全域或副 API）、讀說明（`utils/assistant/knowledge.ts` 的專題，MCP 那篇直接讀 `docs/mcp-user-guide.md`）。
- 知識：`SORE_BASE_KNOWLEDGE` 每輪都帶（功能版圖、首次設定、排查方向、「使用幫助」的常見問題，常見問題搬到 `utils/faqData.ts` 兩邊共用）。**改了 App 的行為（設定在哪、按鈕叫什麼），這裡要跟著改**，不然 Sore 會指錯路。
- 打 API：`utils/assistant/client.ts`。錯誤訊息一律過 `scrubSecret`（整串 Key、前後 12 碼、`sk-…` 長字串都換成 `[Key]`），不讓 Key 進到 Sore 的上下文；回覆只剝 `<think>` 這類有標籤的思考，不用 `stripLeakedReasoning`（那是給角色台詞的，會把 Sore 正常說的「我先看一下」剝掉）。
- 畫面上工具結果只顯示一行小字（🔍 查看設定概況），內容只給模型看。
- 埋點：`向Sore提问`（入口）、`切换Sore的API`（选择），見 `docs/analytics.md`。
- 測試：`utils/assistant/assistant.test.ts`、`utils/assistant/client.test.ts`。

## 10. 實況：第 2 批 · 2a（美化 CSS 的讀寫）

- 位置表：`utils/assistant/cssLocations.ts` 的 `CSS_LOCATIONS`，八個位置（見第 4 節表）。選擇器清單和範圍正則跟協同工作同一份（`features/collaboration/makers.ts` 匯出的 `WHITEBOX_SELECTOR_GROUPS`、`whiteboxSelector`…，日記／日程用各自 `utils/*Appearance.ts` 的），檢查一律 `validateScopedCss`；見面套用時自動限定在 `.date-root`，只查語法和長度。
- 目標：角色、群、自訂氣泡主題用名字或 id 指定，同名要用 id；氣泡主題名字不存在就新建（底色用預設，外觀靠 CSS；還原＝刪掉）。預設氣泡主題不能改。
- 白框 CSS 裡的提示音指令（`@sully-sound` 註釋）：讀的時候拿掉不給 Sore 看，寫的時候接回原本的，Sore 改美化不會弄丟提示音。
- 見面、日記、日程寫的時候保留同一個外觀物件裡的其他欄位（字級、預設皮膚…）。
- 工具（`utils/assistant/tools.ts`）：讀取CSS（不給位置＝各處有沒有設＋角色和群的名字；給位置＝現在的內容＋可用選擇器＋規矩）、寫CSS（整段取代；檢查沒過回錯誤讓它改，過了出提案）、清除CSS（提案）。
- 提案（`AssistantProposal`，掛在工具訊息上存進對話）：卡片（`components/assistant/ProposalCard.tsx`）顯示改哪裡、一句話說明、行數、可展開新的／原本的 CSS；套用／不要；套用後變「已套用 · 還原」。套用、還原在 `utils/assistant/applyProposal.ts`：套用前再檢查一次、確認角色或群還在、記下那一刻的內容當快照；還原前如果那裡又被改過，先問。提案狀態會帶給模型（`[提案狀態：用戶已套用]`）。
- Sore 只出提案，畫面那頭才真的寫（`updateTheme`／`updateCharacter`／`updateGroup`／`addCustomTheme`／`removeCustomTheme`）。
- 修了第 1 批的一個洞：Sore 只叫工具、沒說話的那則原本會被藏掉，連帶藏掉掛在下面的工具行，現在留著。
- 埋點：`处理Sore的提案`（动作、位置）。
- 測試：`utils/assistant/css.test.ts`。
- 還沒做：預覽（2b，白框和氣泡）、傳圖給 Sore（2b）、八處捷徑（2c）。
