# 交接任務：amsg2 滿血 v2 實機驗證

> 給接手的 agent：這是一份端到端實機測試任務，不是寫單測。代碼都在 `dev` 分支上，
> 細節自己翻 `notes/amsg2-reenable-guide.md`（速查檔）和 `notes/amsg-fullbg-state-design.md`（設計）。

## 背景一句話

主動消息 2.0（amsg2）的「滿血 v2 服務端工具循環」已上線：到點由用戶自部署的
Cloudflare Worker 現場生成消息，LLM 輸出裡的數據標籤（查記憶/搜索/日記/小紅書）
worker 就地執行後繼續寫，副作用標籤（戳一戳/日程等）結構化成 directives 隨最後
一條 push 下發、客戶端收到時重放。目前只實測過「聯網搜索」這一條，其餘鏈路要補驗證。

## 環境搭建（自己起一套）

1. **前端**：`dev` 分支 `pnpm install` + `pnpm build`，部署到 Netlify（或任何靜態託管，
   要 HTTPS 才有 Service Worker / 推送）。
2. **Worker**：設置 → 主動消息 2.0 全局設置 → 「部署 Worker」摺疊引導照做
   （複製 `public/amsg-worker.bundle.js` 到 CF 空 Worker、D1 binding `DB`、
   cron `* * * * *`、env 按引導清單填）。**VAPID 必須用前端「推送憑據 (VAPID)」
   面板那一對**，否則推送 403。
3. 前端填 Worker 地址 + 共享密鑰 → 連接 → 開啟推送。
4. **造測試數據**：建一個角色，往角色檔案的月度總結（`char.memories`）裡塞 1–2 條
   編造的記憶；如要測搜索/Notion/飛書，在實時信息設置裡配對應憑據。
5. **跟角色聊一輪**——工具數據（tool_pack / tool_config）是聊完才同步上雲的
   （去抖 15s，切後台立即）。之後在聊天加號面板「主動消息 2.0」排任務。

## 要補的測試（按價值排序）

觀測手段統一是：收到的推送/聊天內容 + CF Dashboard worker 日誌裡的
`[amsg:agentic]`（能看到 `tool_request` → `tool_done`/`tool_failed` → `finish`）。

| # | 測什麼 | 方法 | 通過判定 |
|---|--------|------|---------|
| 1 | 查記憶（RECALL，tool_pack 數據路） | 提示詞任務：「回憶上個月我們做了什麼再來找我聊」 | 消息內容引用了塞進去的月度總結；日誌有 recall 的 tool_done |
| 2 | 副作用 directives 重放 | 提示詞任務：「到點戳我一下，再幫我記個日程」 | 打開 app 後聊天裡出現戳一戳/日程的系統消息；重放只發生一次 |
| 3 | 標籤分段迴歸（剛修過） | 讓角色到點發表情包或卡片類 `[[標籤]]` 內容 | 標籤整塊渲染成表情/卡片，橫幅顯示淨化文本，不出現孤立的 `]]` |
| 4 | 多輪組合 + 旁白累積 | 提示詞任務同時要求「先回憶再搜索」 | 日誌出現 ≥2 輪 tool_request；中間輪的旁白文字排在最終正文前面、沒丟 |
| 5 | 工具優雅降級 | xhsMcpConfig 指向一個不可達地址，提示詞任務讓角色逛小紅書 | 日誌 tool_failed，但角色自己圓場、消息照常送達（鏈不斷） |
| 6 | 無工具數據兜底 | 新角色不聊天直接排程（或先在全局設置裡清除雲端狀態） | fire 不報錯，消息照發（LLM 拿到 no_tool_state 自己圓場） |
| 7 | Notion / 飛書日記（有憑據才測） | 配好憑據後讓角色到點讀某天日記 | 消息內容反映日記內容 |

## 注意

- Worker 代碼有更新時：`pnpm build:workers` 重打 bundle → 先重新部署 worker、再發前端。
- 發現 bug 修復時請配迴歸測試（現有決策邏輯測試在 `worker/amsg/src/agentic.test.ts`，
  數據形狀測試在 `utils/amsgFirePack.test.ts` / `utils/amsgToolPack.test.ts`）。
- 測試結果按上表逐條記錄通過/失敗與日誌摘要即可。
