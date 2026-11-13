# AGENTS.md

給 AI 編程助手（Claude Code 等）的項目導航。SullyOS 是裝在瀏覽器裡的虛擬手機系統（React + TS + Vite，local-first，IndexedDB 存儲）。詳細介紹見 [`README.md`](./README.md)。

這份文件只做一件事：**告訴你遇到某類問題該去翻哪份文檔**，別在代碼裡瞎逛。

> 包管理器統一用 **pnpm**：裝依賴 `pnpm install`、跑測試 `pnpm vitest run`、跑腳本 `pnpm <script>`。別用 npm / yarn（倉庫裡是 `pnpm-lock.yaml`）。

## 文檔地圖

| 主題 | 文檔 | 什麼時候看 |
|------|------|-----------|
| **Soren 路線圖** | [`plans/soren-roadmap.md`](./plans/soren-roadmap.md) | **開始任何新功能前先看**：以 Soren 為主不再跟上游、全部轉繁體、NPC 走獨立表（群聊＋輕量記憶）、單一貼文池、生圖補生成、聊天設置全螢幕等已定案的設計決定與開發順序 |
| **世界書分組與角色綁定** | [`docs/worldbook-management.md`](./docs/worldbook-management.md) | 改世界書觸發方式、整組編輯／刪除、神經鏈接掛載、新入口接世界書前必讀；綁定按 ID，庫與角色緩存同事務更新；「聊天記錄指定深度」和關鍵詞掃描要入口自己接；導入導出與匹配規則照 SillyTavern，不自創欄位 |
| **私聊雙向拉黑＋臨時會話** | [`plans/block-temp-chat-design.md`](./plans/block-temp-chat-design.md) | 改拉黑（誰拉黑誰、擋哪些生成、被拒收訊息、冷靜期解除）或臨時會話前必讀；拉黑中任何路徑都不能讓角色生成私聊訊息 |
| **身份卡 · 關係線（改版中）** | [`plans/persona-bond-redesign.md`](./plans/persona-bond-redesign.md)（整體規劃）、[`plans/persona-line-batch1-2.md`](./plans/persona-line-batch1-2.md)（第 1、2 批詳細設計）、[`plans/persona-line-batch3.md`](./plans/persona-line-batch3.md)（第 3 批：背景功能與雲端）、[`plans/persona-line-batch4.md`](./plans/persona-line-batch4.md)（第 4 批：身份連結、小號與發現、加好友）、[`plans/persona-line-batch5.md`](./plans/persona-line-batch5.md)（第 5 批：群聊裡好幾個身份同場）、[`plans/persona-line-batch6.md`](./plans/persona-line-batch6.md)（第 6 批：NPC 改成配角、角色私聊、AI 生成配角）、[`plans/persona-line-batch7.md`](./plans/persona-line-batch7.md)（第 7 批：角色自己開小號） | 碰私聊訊息的讀寫、角色卡上跟「你」有關的欄位、記憶宮殿前必讀：一個角色可以認識好幾張身份卡，每張一條線（`utils/chatLine.ts`）；主線的訊息不寫 `personaKey`，讀私聊只給 charId 就是主線、只回主線；跟著線走的欄位清單只在 `chatLine.ts` 列一次；主動消息 2.0／即時對話裡非主線是雲端的另一個角色 id（`c1~line~pB`，`utils/amsgCloudLine.ts`），上雲寫 `cloudCharId`、收件用 `findCloudChar`；身份連結與小號的認知在 `utils/personaLinks.ts`、發現在 `utils/personaReveal.ts`，提示詞不能透露哪兩張卡有連結；群裡在場的身份一律走 `utils/groupChat/presence.ts`（可以好幾張，一張都沒有＝旁觀），成員照自己認識的卡看你；配角與下戲在 `utils/castRole.ts`（背景系統一律過 `isOnStage`），角色私聊是 `pair~A~B` 這條線（`utils/pairLine.ts`，只存一份），一般讀私聊的地方碰不到它；角色的小號是一張 `altOf` 指回本人的角色卡（`utils/charAlt.ts`），人設記憶在組提示詞時換成本人的，好友申請在 `utils/altFriend.ts`、認出來在 `utils/altReveal.ts`，列角色的地方記得藏小號 |
| **聊天中私下找人（PRIVATE／DM）** | [`plans/side-messages.md`](./plans/side-messages.md) | 改群聊、角色私聊、你的私聊裡角色私下傳訊息給你某張卡（`[[PRIVATE\|名字: 內容]]`）或私訊別的角色（`[[DM\|名字: 內容]]`）前必讀：名單、上限、拉黑擋、標記解析只在 `utils/sideMessage.ts` 一份，送出去走 `utils/sideMessageRun.ts`；認識才找得到、一輪各 1 條、被私訊後回的那句不再觸發；拉黑中的那條線一律不落 |
| **身份卡 · 世界預設與同世界多身份隔離** | [`plans/multi-persona-isolation-design.md`](./plans/multi-persona-isolation-design.md) | 改身份卡、分世界／分角色／群聊身份指定，或朋友圈、群聊、查手機對聊裡「用戶是誰」前必讀；解析一律走 `utils/userPersona.ts`，同一世界裡不同身份卡是**完全不同的人** |
| **協同工作私聊銜接與轉發** | [`docs/collaboration-chat-bridge.md`](./docs/collaboration-chat-bridge.md) | 改協同讀取 ChatApp 範圍或轉發消息前必讀；每輪讀 DB，空範圍不回退，多選只發當前窗口 |
| **開發調試面板 / 開關** | [`docs/dev-debug.md`](./docs/dev-debug.md) | 加 dev-only 開關、加調試日誌、排查"角色怎麼又不說話了"。含逐步指南 |
| **彼方 · 書庫分類與閱讀偏好** | [`docs/kanata-library.md`](./docs/kanata-library.md) | 改書籍歸類、批量整理、角色選書輪換或書庫備份前必讀；按分類模式不得回退全書庫 |
| **彼方 · 活動選擇與自動範圍** | [`docs/kanata-activities.md`](./docs/kanata-activities.md) | 改房間/SAR 隨機選取、手動子玩法路由或高級排除設置前必讀；自動全禁用不得回退，手動可繞過 |
| **記憶系統** | [`docs/memory-system-overview.md`](./docs/memory-system-overview.md) | 涉及長期記憶、月度總結、向量化記憶宮殿、情感空間。改記憶相關邏輯前必讀 |
| **查手機 · 人際關係系統** | [`docs/relationship-system.md`](./docs/relationship-system.md) | 改「查手機」聊天/通訊錄、角色聯繫人/好感、真假甄別、真角色雙向對話、虛構 NPC 約束前必讀 |
| **見面改版 · 線下故事＋自訂預設** | [`plans/offline-date-redesign.md`](./plans/offline-date-redesign.md) | 改見面一般模式（線下故事、ST 預設匯入／巨集／正則、裝飾 iframe、劇情大綱、開場白、總結、完結、情緒褪色、關閉線上、畫面美化、語音標籤）前必讀；GAL／立繪在這次改版拿掉，匯入的預設不轉繁體 |
| **見面 · 快速離開與「見面中」** | [`docs/date-quick-leave.md`](./docs/date-quick-leave.md) | 改見面選單的「回桌面／去私聊」、掛起與接回、頂端「見面中／通話中」那條前必讀；掛起只在記憶體（`utils/dateSuspend.ts`），進度照舊靠 `savedDateState`；頂端那條要從 `--safe-top` 往下放，放進系統狀態列會點不到 |
| **見面 · 觀測協議 OBSERVE** | [`docs/date-observe.md`](./docs/date-observe.md) | 改見面的角色觀測卡片前必讀：提示詞注入、掉格式解析容錯（兩層）、卡片渲染；只在內建規則下生效，舊訊息的觀測塊不管開不開都要剝掉 |
| **資料庫（相簿改版）** | [`plans/asset-library-design.md`](./plans/asset-library-design.md) | 改資料庫（原本的相簿）、角色傳照片（現場生成的 `SEND_PHOTO`、資料庫現成的 `SEND_SAVED_PHOTO`）、上傳與描述、分配給角色、協同文件歸檔前必讀；沿用 `gallery` 表加欄位、不另開新表，純邏輯在 `utils/library.ts`、角色那頭在 `utils/libraryPrompt.ts`、從私聊發出去在 `utils/libraryShare.ts`；四批做完後補了雲端、批次 AI 寫、從私聊發照片／文件；資料庫生圖頁的改版（暫存、四個分頁、參數、生圖預設、只有我）見 [`plans/library-generate-redesign.md`](./plans/library-generate-redesign.md)，多行輸入框要全螢幕編輯用 `components/common/ExpandableTextarea.tsx` |
| **生圖畫風庫與 API 庫** | [`plans/image-style-presets.md`](./plans/image-style-presets.md) | 改任何生圖入口、生圖設定頁、角色或世界的畫風前必讀：畫風照「這一次 > 角色 > 世界 > 各處畫風那格 > 全域」解析，「關閉」誰也蓋不過，一律走 `utils/imageStyle.ts` 的 `resolveImageStyle`；新的生圖入口呼叫 `generateImage` 要帶 `feature`、`char`、`hasPerson`，事先用 `canGenerateFor` 擋；頂層的 baseUrl／model 是全域那組 API 的鏡像，別直接改；資料庫生圖不看角色和世界；帶參考圖要多像（平衡／還原、GPT-Image 的 `input_fidelity`、中轉不收自動拿掉）見 [`plans/face-lock-strength.md`](./plans/face-lock-strength.md)，一律走 `utils/faceLock.ts`，合照取最強 |
| **桌面網格與小組件** | [`plans/desktop-grid-widgets.md`](./plans/desktop-grid-widgets.md) | 改預設桌面（Launcher）的排版、拖放、頁面、內建小組件、自訂小組件或小組件檔匯入匯出前必讀；每頁 4×6、Android 式（可留空）、寬×高寬在前；版面存 `OSTheme.launcherLayout`，純邏輯在 `utils/launcherLayout.ts`，沒存過的照舊欄位現排、第一次整理才存；自訂小組件模板存 `OSTheme.launcherCustomWidgets`、邏輯在 `utils/customWidget.ts`，關在沙盒 iframe、只轉「點一下」進去，匯入格式相容 `custom_widget_template` v2；`widget.setState` 只認點完 5 秒內的、存了不重載；內建範本在 `utils/widgetStarters.ts`；Dock 能跟網格互換（最多 5 個、存過的不補回預設），樣式在 `utils/dockStyle.ts` |
| **見面 · 畫面美化** | [`docs/date-appearance.md`](./docs/date-appearance.md) | 改見面的底圖遮罩、字級、深淺兩套字色、裝飾卡片底色、自訂 CSS 或加 class 鉤子前必讀；自訂 CSS 一律過 `scopeDateCss` 限定在 `.date-root`，設定頁和彈窗不能放進 `.date-root` |
| **彼方 · 信號墜落處（跨用戶接龍詩）** | [`docs/signal-poetry.md`](./docs/signal-poetry.md) | 改彼方(VRWorld)「信號墜落處」房間：跨實例合寫現代詩、複用漂流瓶後端、`po_poems`/`po_poem_lines` 表與 `/poem/*` 端點、兩層容錯解析、併發安全前必讀 |
| **捏人器 PSD 導入 / 部件投影層** | [`docs/char-creator-psd-import.md`](./docs/char-creator-psd-import.md) | 改捏人器素材管線、部件陰影（正片疊底預轉）、PSD 圖層組約定前必讀 |
| **QQ捏人工坊（神經鏈接手辦櫃）** | [`docs/chibi-studio.md`](./docs/chibi-studio.md) | 改小小窩/彼方/520 三處 Q 版形象、捏人器 savedState 還原、`chibiStudio` 字段前必讀 |
| **銀行（Net Worth＋流水）** | [`plans/finance-wallet-design.md`](./plans/finance-wallet-design.md) | 改查手機／用戶的「餘額管理」、各 block（收入、投資、房產、負債…）、流水、固定收支自動補記或角色【你的錢包】前必讀；純邏輯在 `utils/finance.ts`，AI 生成的流水不動餘額 |
| **購物中心** | [`plans/mall-redesign.md`](./plans/mall-redesign.md) | 改購物中心（私聊「＋」和桌面兩個入口、同一個全螢幕頁）、預設商品與搬遷、訂單與配送進度、AI 補貨提示詞、聊天裡的購物卡片，或角色主動下單（`[[ACTION:GIFT]]`、代付）前必讀；配送狀態只照付款時間算，不存 |
| **新聞熱點（中文熱榜＋國際／台灣新聞）** | [`docs/realtime-news.md`](./docs/realtime-news.md) | 改新聞來源、RSS 代抓（主動消息 2.0 Worker 的 `/news-feeds`）、維基百科退路或勾選語意前必讀；RSS 不走上游的主代理 Worker |
| **用戶所在地節假日感知** | [`docs/user-holidays.md`](./docs/user-holidays.md) | 改設置 → 實時感知 → 節假日感知、各國資料源（台灣是 Soren 自己接的）、用戶資料段那行假日提醒或雲端到點補這行前必讀；日期跟用戶設備時區走，不跟角色 |
| **iOS 27 主螢幕頂端霧玻璃／狀態列底色** | [`docs/ios-status-bar-edge.md`](./docs/ios-status-bar-edge.md) | 改頂端取色、viewport 或 iOS 門禁前必讀；從上游移植：主螢幕 standalone 時改成 `viewport-fit=contain`，零安全區不回退 44px，非同步高度縮小要重建基線；狀態列接的是代表色，不是桌布貫穿 |
| **角色自定義時區** | [`docs/character-timezone.md`](./docs/character-timezone.md) | **寫任何跟時間有關的代碼前先掃一眼**：prompt 裡的「現在是」、角色作息/夜間判斷、日期 key、界面上的鐘。分清「角色那邊幾點」和「用戶自己的時間」，別自己手搓時差。文末列了還沒接時區的幾處（主動消息 + 幾塊界面上的鐘），**正式發版前記得過一遍** |
| **通用 MCP 工具服務器** | [`docs/mcp-client.md`](./docs/mcp-client.md)（開發者）、[`docs/mcp-user-guide.md`](./docs/mcp-user-guide.md)（用戶教程，設置「?」彈窗跳轉的就是它，改接入行為要同步） | 改用戶自配 MCP 接入（設置板塊、握手/session、工具循環、`?target=` 代理約定、worker/mcp-proxy）或排查「工具連不上/角色不調工具」前必讀；主動消息 2.0 的後台 MCP 路徑（配置上雲 / fire 時注入 / worker 直連執行）也在這份 |
| **主動消息 2.0 · 即時對話** | [`plans/amsg2-instant-chat.md`](./plans/amsg2-instant-chat.md)（設計與取捨）、[`plans/amsg2-instant-chat-contract.md`](./plans/amsg2-instant-chat-contract.md)(端點/信封/fire_pack v7 契約) | 改「聊天在用戶自己的 CF Worker 上生成」這條路（`POST /instant-chat`、`utils/amsgInstantChat.ts`、fire_pack 的 `chat` 段、chat_outbox 補收、「正在輸入」超時）前必讀 |
| **主動消息 2.0 · 後台任務（不說話的活兒）** | [`plans/amsg2-expansion.md`](./plans/amsg2-expansion.md) | 改「頁面關著也能跑完」的後台活兒前必讀：`metadata.amsgKind` → handler 註冊表（`worker/amsg/src/fireKinds.ts`）、一次性輸入的 `amsg:job` 命名空間與 TTL、`ctx.emitResult` 的結果回程與客戶端分發（`utils/amsgResults.ts`）。文首「現狀」是實況，正文是「還有哪些調用點值得搬、哪些不該搬」的取捨 |
| **主動消息 · 頻率與額度** | [`docs/amsg2-pacing-limits.md`](./docs/amsg2-pacing-limits.md) | 改角色能自己排什麼、連發/間隔/每日上限、重複消息沒回就停、任務名額，或者改給角色看的「用戶給你定的規矩」前必讀；上限是代碼硬閘，默認值只在 `utils/amsgLimits.ts` 定義一次 |
| **主動消息 2.0 · API 憑據引用 credRefs** | [`plans/amsg2-llm-credentials-contract.md`](./plans/amsg2-llm-credentials-contract.md) | 改憑據上雲（`llm_credentials` 表、任務 `credRefs`、`utils/amsgLlmCredentials.ts` 的每角色三行）或排查「換 Key 後主動消息 401 / 不來了」前必讀；文末「SullyOS 側落地」是實況 |
| **使用統計** | [`docs/analytics.md`](./docs/analytics.md) | **加任何埋點前必讀**。收什麼/不收什麼的邊界、事件名與屬性的規矩（屬性只能是固定枚舉）、構建時門禁與開關、完整事件清單。想加「某功能有多少人開了」看「加新埋點的規矩」第 5 條，別在配置頁現場發 |
| **二改 / 加 App / 數據流 / 後端 Worker** | [`README.md`](./README.md) 「給想二改的人」一節 | 新增 App、build badge、sfworker 代理替換、開源協議 |

> README 的「給想二改的人」區域信息量很大（數據流、ContextBuilder、sfworker 清單），動後端 / 加功能前先掃一遍。

## 什麼時候改版本號

[`utils/buildInfo.ts`](./utils/buildInfo.ts) 裡的 `APP_VERSION`（形如 `S1.0 (First Light)`；Soren 自己一條線，S 開頭，不接上游的 v3.x）是手工維護的，**只有大功能更新才動它**：加了新 App、新系統，或者一整套用戶能直接感知到的新玩法。

性能優化、bug 修復、文案調整、重構這些都不算，做完就是做完了，既不用改版本號，也不用在收尾時問一句「要不要順便升個版本」。拿不準就照這條判斷：用戶在設置頁看到版本號變了，能不能說出多了什麼新東西——說不出來就是不該改。

它有兩個用處：設置頁底部顯示的就是它；統計還拿版本號那半截當標籤，面板按它切分數據。版本號跟著大功能走，標籤才對得上「哪一版鋪開到什麼程度、這版的人在用什麼」；小修小補也跳版本的話，標籤會碎成一堆沒法比的小格子。括號裡的代號只在界面上顯示，不進標籤。構建 hash（`BUILD_LABEL`）是自動生成的，不用管。
