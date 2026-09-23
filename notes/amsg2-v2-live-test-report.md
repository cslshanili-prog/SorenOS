# amsg2 滿血 v2 實機驗證報告

> 對應交接單：[`amsg2-v2-live-test-prompt.md`](./amsg2-v2-live-test-prompt.md)。
> 測試時間：2026-07-18。環境：dev 前端部署 Netlify + 自部署 CF Worker（D1 + cron `* * * * *`）+ 真機推送實測。
> 結論先行：**7 個場景全部通過**，過程中揪出並修掉 3 個真 bug（都帶回歸測試），另有 2 條實測經驗記錄在案。

## 結論總表（交接單 7 場景）

| # | 測什麼 | 結果 | 備註 |
|---|--------|------|------|
| 1 | 查記憶（RECALL，tool_pack 數據路） | ✅ | 消息引用了塞入的月度總結；日誌 `tool_request → tool_done(recall) → finish` |
| 2 | 副作用 directives 重放 | ✅ | 戳一戳/日程/寫日記系統消息正常出現，重放一次 |
| 3 | 標籤分段迴歸 | ✅ | 標籤整塊渲染，橫幅淨化文本，無孤立 `]]` |
| 4 | 多輪組合 + 旁白累積 | ✅ | 多輪 `tool_request`，旁白排正文前不丟（含跨輪標籤塊拼回，見 bug 3） |
| 5 | 工具優雅降級 | ✅ | `tool_failed` 后角色圓場，鏈不斷 |
| 6 | 無工具數據兜底 | ✅ | fire_pack 讀不到時退凍結提示詞照發（413 時期反覆驗證過這條兜底） |
| 7 | Notion / 飛書日記 | ✅ | 日記真實寫入（修完 bug 3 之後） |

---

## 實測揪出的 3 個 bug 與修法

### Bug 1：XHS 筆記卡片必掉——round 1 筆記只活在 worker 內存

**現象**：角色到點逛小紅書、日誌 `tool_request(xhs_search) → tool_done → finish` 一路正常，
但客戶端重放 `[[XHS_SHARE: n]]` 時控制台刷
`📕 [XHS] XHS_SHARE 序號越界, 跳過卡片 {idx: …, available: 0}`，卡片靜默消失。

**根因**：XHS 分享是兩輪協議——round 1 工具抓筆記存進緩衝，round 2 `[[XHS_SHARE: 序號]]`
按序號取卡。instant push 路徑的 round 1 在**客戶端**跑（instantToolRunner 會
`saveXhsSessionNotes` 落 IndexedDB）；amsg2 滿血 v2 的 round 1 在 **worker** 裡跑，
筆記只活在 worker 單次 fire 的內存裡，從沒送到客戶端——重放時緩衝永遠是空的。
結構性缺口，不是偶發。

**修法**（`worker/amsg/src/agentic.ts` + `index.ts`、`utils/activeMsgRuntime.ts`、
`utils/applyAssistantPostProcessing.ts`）：
- worker finish 時掃 directives，把被 `xhs_share` 引用的筆記（+點贊/評論要用的
  xsecToken）組成 `metadata.xhsSession` 掛**最後一條 push**（與 directives 同車）；
- 只帶引用到的最多 4 張、desc 截 120 字——web push 單條 payload ~4KB，全量 8 張
  會把整條 push 撐爆，掉卡片就升級成掉消息；LLM 編造的越界序號 worker 側直接跳過；
- 客戶端收到 `xhsSession` 先按序號重建稀疏數組落庫，再走與 instant 共用的既有恢復路；
  `XHS_SHARE` 重放循環補稀疏空洞（null）守衛。

**迴歸測試**：`agentic.test.ts` 新增 8 例（引用挑選、越界跳過、desc 截斷不改原數組、
token 按 noteId 過濾、無 XHS 引用不多掛鍵、上限 4 張、掛最後一條 push、形狀迴歸）。

### Bug 2：上下文一長 `PUT /client-state` 413——一個胖角色拖垮整批同步

**現象**：角色卡大/世界書長/聊天多的角色，聊完一輪同步即
`413 (Payload Too Large)`。體驗上角色到點照樣回覆（凍結提示詞兜底），但滿血鏈路
對這個角色**永遠夠不著**：上下文凍結在排程那刻、服務端工具循環全廢；且
putClientState 是整批請求、服務端校驗 all-or-nothing——同批**其他角色**也一起沒同步上。

**根因**：amsg-server 對單條 client_state value 有 200KB 硬上限
（`MAX_STATE_VALUE_BYTES`），fire_pack = 完整系統提示詞（角色卡+世界書）+ 最近
30 行對話，重角色輕鬆超限。上傳口子有兩個（聊完去抖沖刷 + 排任務即時同步），
都會觸發。

**修法**（新增 `utils/amsgStateChunks.ts`，改 `utils/activeMsgClient.ts`、
`worker/amsg/src/index.ts`）——**分塊上傳，內容零損失**（明確不裁用戶內容）：
- 值 ≤196KB → 單條原樣直傳（與歷史行為字節級一致）；
- 超限 → 切成 `<key>.0` / `<key>.1` … 子條目（每塊 6 萬 UTF-16 units，全中文
  最壞 180KB，必在限內；切點避開 emoji 代理對），根條目寫一份小 meta
  `{__chunked:1, chunks:N}`；
- worker 到點讀 fire_pack / tool_pack / tool_config 時先按 meta 拼回原文再 parse；
  缺塊（同步被打斷）→ null → 照舊退凍結提示詞；
- 兼容性：老 worker 讀到 meta 根條目時 `parseFirePack`/`parseToolPack` 形狀校驗
  不過 → null → 走既有兜底，鏈不斷（有測試釘住）。

**迴歸測試**：新增 `utils/amsgStateChunks.test.ts` 8 例（小值直傳、1.2MB 中文包
逐塊限內且拼回逐字一致、emoji 不劈半、缺塊退兜底、老形態透傳、meta 喂
parseFirePack 得 null、entries 鍵名/同批同 updatedAt）。

### Bug 3：寫日記寫一半去查記憶——長形態標籤塊被數據標籤劈成兩輪

**現象**：推送橫幅直接出現裸標籤 `[[DIARY_START: 專屬點讀機 | 傲嬌]]` 和
`[[DIARY_END]]`（各佔一條 push），日記沒寫進 Notion，打開 App 聊天裡也什麼都沒有。

**根因**：LLM 輸出
`[[DIARY_START: …]]\n內容…[[RECALL: …]]（工具輪）…內容\n[[DIARY_END]]`——
數據標籤把文本劈成兩輪。老邏輯**逐輪**掃副作用標籤，而日記長形態正則要求
START/END 同輪配對：兩半各自配不上 → directive 沒生成（日記丟）、裸標籤當正文
漏進 push（橫幅難看）、客戶端收到孤立標籤又被淨化剝掉（聊天空白）。三個症狀同根。

**修法**（`worker/amsg/src/agentic.ts`）：中間輪旁白改存**原始文本**（不逐輪剝
副作用標籤），finish 時把「全部旁白 + 最終正文」拼回一份全文統一 classify——
被劈開的標籤塊自然合體，一次掃出全部 directives。飛書長形態同款免疫。

**迴歸測試**：`agentic.test.ts` 新增 2 例（Notion 日記劈兩輪拼回後
title/mood/跨輪內容齊全、正文無裸標籤；飛書同款），並更新旁白語義相關斷言。

---

## 實測經驗（不是 bug，但會讓人白排查半天）

1. **「需要二次調用的工具一個都不動」大概率是沒配憑據，不是鏈路壞了。**
   Notion/飛書/搜索/小紅書的標籤指令是按「實時信息設置裡開關+憑據齊全」**逐個門控**
   注入系統提示的（`chatPrompts.ts`）；沒配 → 提示詞裡壓根沒有那個標籤的說明 →
   LLM 不知道自己會 → 日誌只有一條 `finish`、零 `tool_request`。
   **配完必須再跟角色聊一輪**（工具指令是聊天時烤進 fire_pack、憑據打進 tool_config
   同批上雲的），然後再排任務。RECALL 是無條件開放的，適合先拿它驗證工具循環
   端到端通不通，再逐個加憑據類工具。
2. **部署順序**：worker 代碼更新（`pnpm build:workers` → CF 粘貼）要**先於**前端
   發佈。順序反了不炸——老 worker 讀到新格式自動落兜底——但滿血鏈路要等 worker
   跟上才生效。

## 改動清單

| 文件 | 改動 |
|------|------|
| `worker/amsg/src/agentic.ts` | finish 全文統一 classify（bug 3）+ `buildXhsSessionPayload`（bug 1） |
| `worker/amsg/src/index.ts` | XHS 快照傳入決策邏輯（bug 1）+ 三份 client_state 拼塊讀回（bug 2） |
| `utils/amsgStateChunks.ts` | 新增：client_state 大值分塊/拼回純邏輯（bug 2） |
| `utils/activeMsgClient.ts` | 兩個上傳口子改走分塊 entries（bug 2） |
| `utils/activeMsgRuntime.ts` | push 攜帶的 xhsSession 落庫複用 instant 恢復路（bug 1） |
| `utils/applyAssistantPostProcessing.ts` | XHS_SHARE 稀疏數組空洞守衛（bug 1） |
| `worker/amsg/src/agentic.test.ts` | +10 例迴歸 |
| `utils/amsgStateChunks.test.ts` | 新增 8 例迴歸 |
| bundles | `worker/amsg/worker.bundle.js` + `public/amsg-worker.bundle.js` 已重打 |

測試基線：`pnpm vitest run` 相關套件全綠（agentic 19 + stateChunks 8 + firePack 15 +
toolPack 6 + sanitize 66 + pushDecision 28）；`tsc --noEmit` 觸及文件零新增錯誤。
