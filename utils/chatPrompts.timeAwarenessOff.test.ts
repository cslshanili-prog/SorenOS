import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';

// 2026-11-17 Liora 實測：關掉「時間感知強化」，角色還是能精確到分鐘說多久沒聊。
// 以前只拿掉「距離上一條消息多久」那句，歷史每則前面的 [2026-11-16 23:41] 還在，模型自己一減就有了。
// 現在關掉就一則都不標。

const DAY = 86_400_000;
const now = Date.now();
const user = { name: 'Lorna' } as any;
const msg = (id: number, role: 'user' | 'assistant', timestamp: number, extra: any = {}) =>
    ({ id, charId: 'c1', role, type: 'text', content: `第${id}則`, timestamp, ...extra }) as any;
const text = (c: any) => (typeof c === 'string' ? c : c.map((p: any) => p.text || '').join(''));
const history = [msg(1, 'user', now - 3 * DAY), msg(2, 'assistant', now - 3 * DAY + 60_000), msg(3, 'user', now - 3 * DAY + 120_000, { type: 'interaction' }), msg(4, 'user', now)];

describe('時間感知關掉：歷史不帶時間戳', () => {
    it('預設（開著）：每則都有時間戳、最後一則帶距離上次多久', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, { id: 'c1', name: 'V' } as any, user, []);
        const texts = apiMessages.map(m => text(m.content));
        expect(texts.every(t => /^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\]/.test(t))).toBe(true);
        expect(texts[texts.length - 1]).toMatch(/距離上一條消息: [23] 天/);
    });

    it('關掉：一則都沒有時間戳、也沒有距離上次多久，開頭不留空格', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, { id: 'c1', name: 'V', timeAwarenessEnabled: false } as any, user, []);
        const texts = apiMessages.map(m => text(m.content));
        expect(texts.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(texts.join('\n')).not.toContain('距離上一條消息');
        expect(texts.every(t => !t.startsWith(' '))).toBe(true);
        expect(texts[0]).toBe('[聊天] 第1則');
        expect(texts[2]).toBe('[系統: 用戶戳了你一下]');
    });

    it('showTimestamps 可以逐則指定（見面的故事時鐘用）', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, { id: 'c1', name: 'V' } as any, user, [], undefined, { showTimestamps: m => m.id === 4, skipTimeGapHint: true });
        const texts = apiMessages.map(m => text(m.content));
        expect(texts[0]).toBe('[聊天] 第1則');
        expect(texts[3]).toMatch(/^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}\] \[聊天\] 第4則$/);
        expect(texts.join('\n')).not.toContain('距離上一條消息');
    });
});
