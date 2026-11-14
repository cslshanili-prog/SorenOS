import { describe, expect, it } from 'vitest';
import { chatGreetingsOf, dateGreetingsOf, greetingsOf, greetingsPatch, mergeDateEdits } from './greetings';

describe('開場白清單', () => {
    it('舊的 dateGreetings 讀成勾了見面的', () => {
        const old = { dateGreetings: [{ id: 'd1', text: '雨夜' }] };
        expect(greetingsOf(old)).toEqual([{ id: 'd1', text: '雨夜', date: true }]);
        expect(dateGreetingsOf(old)).toHaveLength(1);
        expect(chatGreetingsOf(old)).toHaveLength(0);
        // 有新清單就只看新清單
        expect(greetingsOf({ greetings: [], dateGreetings: [{ id: 'x', text: 'y' }] })).toEqual([]);
    });

    it('寫回：空白的拿掉、舊欄位清掉', () => {
        expect(greetingsPatch([{ id: 'a', text: ' ' }, { id: 'b', text: '嗨', chat: true }])).toEqual({ greetings: [{ id: 'b', text: '嗨', chat: true }], dateGreetings: undefined });
        expect(greetingsPatch([])).toEqual({ greetings: undefined, dateGreetings: undefined });
        expect(greetingsPatch([{ id: 'a', text: '' }], { keepBlank: true }).greetings).toHaveLength(1);
    });

    it('見面那邊改完併回整份', () => {
        const all = [
            { id: 'c', text: '私聊用', chat: true },
            { id: 'both', text: '兩邊', chat: true, date: true },
            { id: 'd', text: '見面用', date: true },
        ];
        // 改字、刪掉 both（還勾私聊 → 只取消見面）、刪掉 d（整段刪）、新增一段
        const out = mergeDateEdits(all, [{ id: 'new', text: '新的' }]);
        expect(out).toEqual([
            { id: 'c', text: '私聊用', chat: true },
            { id: 'both', text: '兩邊', chat: true, date: false },
            { id: 'new', text: '新的', date: true },
        ]);
        expect(mergeDateEdits(all, [{ id: 'd', text: '改過' }, { id: 'both', text: '兩邊' }]).find(g => g.id === 'd')?.text).toBe('改過');
    });
});
