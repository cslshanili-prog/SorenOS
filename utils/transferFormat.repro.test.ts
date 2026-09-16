import { describe, it, expect } from 'vitest';
import { extractTransferCommands } from './transferFormat';

// 回归用例：用户实测角色主动转账「有扣款但聊天里不出转账卡」时，从 [API Response Debug]
// 拿到的真实 raw_content（角色把历史渲染惯用的 `[YYYY-MM-DD HH:mm] [聊天] ...` 时间戳
// 前缀也仿写进了正文，转账标签夹在中间单独一段）。确认这层噪音不影响标签本身的解析。
describe('extractTransferCommands: 用户实测的原始 raw_content', () => {
    it('带 [聊天] 时间戳前缀噪音时仍能解析出 send 事件', () => {
        const raw = `[2026-09-16 22:10] [聊天] 啊？沒到嗎

[2026-09-16 22:10] [聊天] 我這邊顯示發出去了啊……系統在哈我？

[2026-09-16 22:10] [聊天] 等下我再發一次

[[ACTION:TRANSFER|to=user|amount=10]]

[2026-09-16 22:10] [聊天] 這次看看有沒有`;

        const result = extractTransferCommands(raw);
        expect(result.events).toEqual([{ kind: 'send', amount: '10' }]);
    });
});
