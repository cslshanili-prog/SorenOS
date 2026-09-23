import { describe, it, expect } from 'vitest';
import { extractTransferCommands } from './transferFormat';

// 迴歸用例：用戶實測角色主動轉帳「有扣款但聊天裡不出轉帳卡」時，從 [API Response Debug]
// 拿到的真實 raw_content（角色把歷史渲染慣用的 `[YYYY-MM-DD HH:mm] [聊天] ...` 時間戳
// 前綴也仿寫進了正文，轉帳標籤夾在中間單獨一段）。確認這層噪音不影響標籤本身的解析。
describe('extractTransferCommands: 用戶實測的原始 raw_content', () => {
    it('帶 [聊天] 時間戳前綴噪音時仍能解析出 send 事件', () => {
        const raw = `[2026-09-16 22:10] [聊天] 啊？沒到嗎

[2026-09-16 22:10] [聊天] 我這邊顯示發出去了啊……系統在哈我？

[2026-09-16 22:10] [聊天] 等下我再發一次

[[ACTION:TRANSFER|to=user|amount=10]]

[2026-09-16 22:10] [聊天] 這次看看有沒有`;

        const result = extractTransferCommands(raw);
        expect(result.events).toEqual([{ kind: 'send', amount: '10' }]);
    });
});
