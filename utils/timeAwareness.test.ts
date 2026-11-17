import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { ContextBuilder } from './context';
import { hasTimeAwareness, resolveTimeAwareness, timeAwarenessPatch } from './timeAwareness';
import { interactionGapNote } from './timezone';

// 時間感知三檔（plans/time-system.md 第 2d 節、utils/timeAwareness.ts）

const DAY = 86_400_000;
const now = Date.now();
const user = { name: 'Lorna' } as any;
const msg = (id: number, role: 'user' | 'assistant', timestamp: number) =>
    ({ id, charId: 'c1', role, type: 'text', content: `第${id}則`, timestamp }) as any;
const text = (c: any) => (typeof c === 'string' ? c : c.map((p: any) => p.text || '').join(''));

describe('讀檔位', () => {
    it('沒新欄位：舊布林 false → 不知道，其餘 → 精確', () => {
        expect(resolveTimeAwareness({})).toBe('precise');
        expect(resolveTimeAwareness({ timeAwarenessEnabled: true })).toBe('precise');
        expect(resolveTimeAwareness({ timeAwarenessEnabled: false })).toBe('none');
        expect(resolveTimeAwareness(undefined)).toBe('precise');
    });
    it('有新欄位就照新欄位；介面改檔位兩個欄位一起寫', () => {
        expect(resolveTimeAwareness({ timeAwareness: 'coarse', timeAwarenessEnabled: false })).toBe('coarse');
        expect(timeAwarenessPatch('none')).toEqual({ timeAwareness: 'none', timeAwarenessEnabled: false });
        expect(timeAwarenessPatch('coarse')).toEqual({ timeAwareness: 'coarse', timeAwarenessEnabled: true });
        expect(hasTimeAwareness({ timeAwareness: 'none' })).toBe(false);
        expect(hasTimeAwareness({ timeAwareness: 'coarse' })).toBe(true);
    });
});

describe('粗略：只有日期和早中晚、隔了幾天、記錄只標日期', () => {
    const coarse = { id: 'c1', name: 'V', timeAwareness: 'coarse' } as any;
    it('現在幾點那段沒有幾點幾分', () => {
        const block = ContextBuilder.buildTimeAwarenessBlock(coarse);
        expect(block).toContain('現在是 ');
        expect(block).not.toMatch(/\d{2}:\d{2}/);
        expect(block).toContain('說不出幾點幾分');
        const precise = ContextBuilder.buildTimeAwarenessBlock({ id: 'c1', name: 'V' } as any);
        expect(precise).toMatch(/\d{2}:\d{2}/);
        expect(ContextBuilder.buildTimeAwarenessBlock({ id: 'c1', name: 'V', timeAwareness: 'none' } as any)).toBe('');
    });
    it('距離上次聯繫：不滿一天不提，滿了只說幾天', () => {
        expect(interactionGapNote(now - 5 * 3_600_000, now, true)).toBe('');
        expect(interactionGapNote(now - 3 * DAY - 1000, now, true)).toContain('大概過了 3 天');
        expect(interactionGapNote(now - 5 * 3_600_000, now)).toContain('5 小時');
        expect(ChatPrompts.getTimeGapHint(msg(1, 'user', now - 3 * 3_600_000), now, undefined, true)).toBe('');
        expect(ChatPrompts.getTimeGapHint(msg(1, 'user', now - 2 * DAY), now, undefined, true)).toBe('[系統提示: 距離上一條消息大概 2 天。]');
    });
    it('歷史只標日期，最後一則的時間差只到天', () => {
        const history = [msg(1, 'user', now - 3 * DAY), msg(2, 'assistant', now - 3 * DAY + 60_000), msg(3, 'user', now)];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, coarse, user, []);
        const texts = apiMessages.map(m => text(m.content));
        expect(texts[0]).toMatch(/^\[\d{4}-\d{2}-\d{2}\] \[聊天\] 第1則$/);
        expect(texts.join('\n')).not.toMatch(/\d{2}:\d{2}/);
        expect(texts[2]).toContain('距離上一條消息大概 2 天');
    });
    it('不知道：什麼都不標', () => {
        const history = [msg(1, 'user', now - 3 * DAY), msg(2, 'user', now)];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 50, { id: 'c1', name: 'V', timeAwareness: 'none', timeAwarenessEnabled: true } as any, user, []);
        const texts = apiMessages.map(m => text(m.content));
        expect(texts.join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}/);
        expect(texts.join('\n')).not.toContain('距離上一條消息');
    });
});
