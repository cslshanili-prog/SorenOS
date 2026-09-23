# 私聊流式預覽與正式消息交接

2026-09-12：修復流式回覆先顯示、隨後消失再整批彈出的現象。

## 交接規則

`applyAssistantPostProcessing` 會逐條保存、重新讀取消息。即使啟用了 `instantRender`，異步寫庫之間仍可能有多幀；第一條正式消息出現不代表整輪已經完成。

- `hooks/useChatAI.ts` 保留整組預覽直到後處理完成，期間逐次登記與預覽匹配的正式消息 ID。
- `apps/Chat.tsx` 在預覽仍顯示時隱藏本輪這些正式消息，避免重複。整輪完成才撤去預覽、展示正式消息。
- 當前輪次的臨時隱藏 ID 與已有的入場動畫抑制記錄分開：下一輪不能隱藏上一輪回復。正式消息接棒時不重新播放入場動畫。
- 未被預覽覆蓋的卡片等消息繼續正常展示；不改變解析、持久化或消息來源過濾。
- 出錯時撤掉未保存的預覽，保留實際已保存的消息與錯誤提示。

## 迴歸驗證

`scripts/test-chat-stream-handover.mjs` 連接本地 Vite 的真實 Chat 測試入口，通過本地 SSE 返回三條回覆，並暫停第二、第三條 IndexedDB 寫入。測試連續兩輪相同內容，逐幀檢查氣泡不消失、不重複，正式消息不重播入場動畫；另模擬第二條保存失敗，驗證預覽清理。

入口：`test/fixtures/chat-stream-handover.html`。測試專用寫入暫停器只存在於該入口，不進入生產應用。啟動 Vite 到 5183 後使用倉庫的 Playwright loader 運行腳本。

相關單元迴歸：`streamPreview`、`safeApi.stream`、`chatReplyLifecycle`、`applyAssistantPostProcessing`。
