# AGENTS.md

給 AI 編程助手（Claude Code 等）的項目導航。SullyOS 是裝在瀏覽器裡的虛擬手機系統（React + TS + Vite，local-first，IndexedDB 存儲）。詳細介紹見 [`README.md`](./README.md)。

這份文件只做一件事：**告訴你遇到某類問題該去翻哪份文檔**，別在代碼裡瞎逛。

> 包管理器統一用 **pnpm**：裝依賴 `pnpm install`、跑測試 `pnpm vitest run`、跑腳本 `pnpm <script>`。別用 npm / yarn（倉庫裡是 `pnpm-lock.yaml`）。

## 文檔地圖

| 主題 | 文檔 | 什麼時候看 |
|------|------|-----------|
| **Soren 路線圖** | [`plans/soren-roadmap.md`](./plans/soren-roadmap.md) | **開始任何新功能前先看**：以 Soren 為主不再跟上游、全部轉繁體、NPC 走獨立表（群聊＋輕量記憶）、單一貼文池、生圖補生成、聊天設置全螢幕等已定案的設計決定與開發順序 |
| **世界書分組與角色綁定** | [`docs/worldbook-management.md`](./docs/worldbook-management.md) | 改世界書觸發方式、整組編輯／刪除、神經鏈接掛載前必讀；綁定按 ID，庫與角色緩存同事務更新 |
| **協同工作私聊銜接與轉發** | [`docs/collaboration-chat-bridge.md`](./docs/collaboration-chat-bridge.md) | 改協同讀取 ChatApp 範圍或轉發消息前必讀；每輪讀 DB，空範圍不回退，多選只發當前窗口 |
| **開發調試面板 / 開關** | [`docs/dev-debug.md`](./docs/dev-debug.md) | 加 dev-only 開關、加調試日誌、排查"角色怎麼又不說話了"。含逐步指南 |
| **彼方 · 書庫分類與閱讀偏好** | [`docs/kanata-library.md`](./docs/kanata-library.md) | 改書籍歸類、批量整理、角色選書輪換或書庫備份前必讀；按分類模式不得回退全書庫 |
| **彼方 · 活動選擇與自動範圍** | [`docs/kanata-activities.md`](./docs/kanata-activities.md) | 改房間/SAR 隨機選取、手動子玩法路由或高級排除設置前必讀；自動全禁用不得回退，手動可繞過 |
| **記憶系統** | [`docs/memory-system-overview.md`](./docs/memory-system-overview.md) | 涉及長期記憶、月度總結、向量化記憶宮殿、情感空間。改記憶相關邏輯前必讀 |
| **查手機 · 人際關係系統** | [`docs/relationship-system.md`](./docs/relationship-system.md) | 改「查手機」聊天/通訊錄、角色聯繫人/好感、真假甄別、真角色雙向對話、虛構 NPC 約束前必讀 |
| **見面 · 觀測協議 OBSERVE** | [`docs/date-observe.md`](./docs/date-observe.md) | 改見面（DateApp）的角色觀測面板：提示詞注入、掉格式解析容錯（兩層）、全息 HUD 渲染前必讀 |
| **彼方 · 信號墜落處（跨用戶接龍詩）** | [`docs/signal-poetry.md`](./docs/signal-poetry.md) | 改彼方(VRWorld)「信號墜落處」房間：跨實例合寫現代詩、複用漂流瓶後端、`po_poems`/`po_poem_lines` 表與 `/poem/*` 端點、兩層容錯解析、併發安全前必讀 |
| **捏人器 PSD 導入 / 部件投影層** | [`docs/char-creator-psd-import.md`](./docs/char-creator-psd-import.md) | 改捏人器素材管線、部件陰影（正片疊底預轉）、PSD 圖層組約定前必讀 |
| **QQ捏人工坊（神經鏈接手辦櫃）** | [`docs/chibi-studio.md`](./docs/chibi-studio.md) | 改小小窩/彼方/520 三處 Q 版形象、捏人器 savedState 還原、`chibiStudio` 字段前必讀 |
| **角色自定義時區** | [`docs/character-timezone.md`](./docs/character-timezone.md) | **寫任何跟時間有關的代碼前先掃一眼**：prompt 裡的「現在是」、角色作息/夜間判斷、日期 key、界面上的鐘。分清「角色那邊幾點」和「用戶自己的時間」，別自己手搓時差。文末列了還沒接時區的幾處（主動消息 + 幾塊界面上的鐘），**正式發版前記得過一遍** |
| **通用 MCP 工具服務器** | [`docs/mcp-client.md`](./docs/mcp-client.md)（開發者）、[`docs/mcp-user-guide.md`](./docs/mcp-user-guide.md)（用戶教程，設置「?」彈窗跳轉的就是它，改接入行為要同步） | 改用戶自配 MCP 接入（設置板塊、握手/session、工具循環、`?target=` 代理約定、worker/mcp-proxy）或排查「工具連不上/角色不調工具」前必讀；主動消息 2.0 的後台 MCP 路徑（配置上雲 / fire 時注入 / worker 直連執行）也在這份 |
| **主動消息 2.0 · 即時對話** | [`plans/amsg2-instant-chat.md`](./plans/amsg2-instant-chat.md)（設計與取捨）、[`plans/amsg2-instant-chat-contract.md`](./plans/amsg2-instant-chat-contract.md)(端點/信封/fire_pack v7 契約) | 改「聊天在用戶自己的 CF Worker 上生成」這條路（`POST /instant-chat`、`utils/amsgInstantChat.ts`、fire_pack 的 `chat` 段、chat_outbox 補收、「正在輸入」超時）前必讀 |
| **主動消息 2.0 · 後台任務（不說話的活兒）** | [`plans/amsg2-expansion.md`](./plans/amsg2-expansion.md) | 改「頁面關著也能跑完」的後台活兒前必讀：`metadata.amsgKind` → handler 註冊表（`worker/amsg/src/fireKinds.ts`）、一次性輸入的 `amsg:job` 命名空間與 TTL、`ctx.emitResult` 的結果回程與客戶端分發（`utils/amsgResults.ts`）。文首「現狀」是實況，正文是「還有哪些調用點值得搬、哪些不該搬」的取捨 |
| **主動消息 2.0 · API 憑據引用 credRefs** | [`plans/amsg2-llm-credentials-contract.md`](./plans/amsg2-llm-credentials-contract.md) | 改憑據上雲（`llm_credentials` 表、任務 `credRefs`、`utils/amsgLlmCredentials.ts` 的每角色三行）或排查「換 Key 後主動消息 401 / 不來了」前必讀；文末「SullyOS 側落地」是實況 |
| **使用統計** | [`docs/analytics.md`](./docs/analytics.md) | **加任何埋點前必讀**。收什麼/不收什麼的邊界、事件名與屬性的規矩（屬性只能是固定枚舉）、構建時門禁與開關、完整事件清單。想加「某功能有多少人開了」看「加新埋點的規矩」第 5 條，別在配置頁現場發 |
| **二改 / 加 App / 數據流 / 後端 Worker** | [`README.md`](./README.md) 「給想二改的人」一節 | 新增 App、build badge、sfworker 代理替換、開源協議 |

> README 的「給想二改的人」區域信息量很大（數據流、ContextBuilder、sfworker 清單），動後端 / 加功能前先掃一遍。

## 什麼時候改版本號

[`utils/buildInfo.ts`](./utils/buildInfo.ts) 裡的 `APP_VERSION`（形如 `v3.0 (Ambient Presence)`）是手工維護的，**只有大功能更新才動它**：加了新 App、新系統，或者一整套用戶能直接感知到的新玩法。

性能優化、bug 修復、文案調整、重構這些都不算，做完就是做完了，既不用改版本號，也不用在收尾時問一句「要不要順便升個版本」。拿不準就照這條判斷：用戶在設置頁看到版本號變了，能不能說出多了什麼新東西——說不出來就是不該改。

它有兩個用處：設置頁底部顯示的就是它；統計還拿版本號那半截當標籤，面板按它切分數據。版本號跟著大功能走，標籤才對得上「哪一版鋪開到什麼程度、這版的人在用什麼」；小修小補也跳版本的話，標籤會碎成一堆沒法比的小格子。括號裡的代號只在界面上顯示，不進標籤。構建 hash（`BUILD_LABEL`）是自動生成的，不用管。
