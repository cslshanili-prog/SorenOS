# 協同工作：私聊銜接與選擇轉發

2026-09-13 修復。

## 私聊輸入

`features/collaboration/chatBridge.ts` 在每次生成前從 DB 讀取當前角色與最新上下文範圍。不能使用 Chat 頁面傳入的 `recentChatMessages` 作為生成數據源：它只是 UI 當前分頁，可能陳舊或缺少消息。

「用戶設定範圍」沿用 `loadCharacterContextRange` 的手動斷點、自適應記憶水位和最大範圍。「最近 10／20 條」在相同範圍內再取末尾 N 條；「不讀取」不讀聊天記錄。範圍為空時保持為空，不回退全庫，不越過用戶邊界。只選擇當前角色的私聊，不帶其他角色或群聊。

兩種協同模式仍保留原差異：沉浸式帶完整 ChatApp 角色上下文，中度協同只追加私聊原文。實際請求明確標出 ChatApp 私聊的開始、結束及當前協同窗口，避免模型把「窗口獨立」誤解成「上文沒有私聊」。界面顯示本次讀取條數。

模型自述“看不到 ChatApp”不能單獨證明請求沒有攜帶記錄。驗證時檢查最終發送請求的 messages；已有範圍外的舊內容仍不會出現，不能為避免這句話而偷偷擴大範圍。

## 轉發到 ChatApp

頂部發送按鈕先打開選擇頁，默認不選；支持逐條勾選、全選、清空、取消。確認後只轉發選中且屬於當前窗口的 user/assistant 消息，保留原順序及所選附件文字，不包括思考過程或其它協同窗口。仍通過原有 `onSendToChat` 寫入一張轉發卡，不自動混入日常聊天。

## 驗證

- `utils/collaborationChatBridge.test.ts`：每次讀取最新 DB、固定條數、最新手動斷點、空自適應範圍、角色／群聊隔離與選擇轉發。
- 既有 collaborationContext / collaborationWiring 迴歸。
- `scripts/test-worldbook-cowork.mjs`：真實協同 UI → 本地 mock API，檢查最終請求包含私聊；窗口打開後追加私聊，再選「最近 20 條」生成，仍讀到新內容；只選一條轉發時回調只收到該條。

瀏覽器測試入口 `test/fixtures/worldbook-cowork.html`，Vite 端口 5183；使用倉庫 Playwright loader。測試素材及模型請求只在隔離瀏覽器和本地 mock 服務裡運行。
