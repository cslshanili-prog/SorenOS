import { describe, expect, it } from 'vitest';
import {
    buildFragmentPrompt, clearableFragments, dayWorthWriting, fragmentsOfDay, fragmentTagsFor, groupByDay, newFragmentEntry,
    parseFragmentPick, pendingDays, settleQuote, splitParts, tagTone,
} from './fragment';
import { bondPromptBlock, promptMoments } from './prompt';

const msg = (id: number, role: 'user' | 'assistant', content: string, timestamp = id * 1000) => ({ id, role, type: 'text', content, timestamp, charId: 'c1' }) as any;

describe('拾光片段：分天與挑哪幾天', () => {
    it('照故事日期分組，天從舊到新、天裡照 id', () => {
        const days = groupByDay([msg(3, 'user', 'c', 3), msg(1, 'user', 'a', 1), msg(2, 'assistant', 'b', 2)], ts => (ts < 3 ? '2026-11-01' : '2026-11-02'));
        expect(days.map(d => d.dayKey)).toEqual(['2026-11-01', '2026-11-02']);
        expect(days[0].messages.map(m => m.id)).toEqual([1, 2]);
    });
    it('兩邊都說過話才值得寫；角色之間只要有兩則', () => {
        expect(dayWorthWriting([msg(1, 'user', '早')])).toBe(false);
        expect(dayWorthWriting([msg(1, 'user', '早'), msg(2, 'user', '在嗎')])).toBe(false);
        expect(dayWorthWriting([msg(1, 'user', '早'), msg(2, 'assistant', '早安')])).toBe(true);
        expect(dayWorthWriting([msg(1, 'assistant', 'a'), msg(2, 'assistant', 'b')], true)).toBe(true);
    });
    it('寫過的天跳過；太長的一天分段', () => {
        expect(pendingDays(['a', 'b', 'c'], { b: 1 })).toEqual(['a', 'c']);
        expect(splitParts([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
        expect(splitParts([], 2)).toEqual([]);
    });
});

describe('拾光片段：提示詞與解析', () => {
    it('路線決定 tag 清單；友情線提醒不往戀愛寫', () => {
        expect(fragmentTagsFor('romance')).toContain('心動');
        expect(fragmentTagsFor('friendship')).not.toContain('心動');
        const p = buildFragmentPrompt({ selfName: 'Sully', otherName: 'Liora', dayLabel: '11 月 16 日', from: 'chat', transcript: '#1 [10:00] Liora：早', tags: fragmentTagsFor('friendship'), route: 'friendship', max: 3 });
        expect(p).toContain('你和Liora在11 月 16 日的聊天紀錄');
        expect(p).toContain('不要往戀愛的方向寫');
        expect(buildFragmentPrompt({ selfName: 'A', otherName: 'B', pair: true, dayLabel: 'd', from: 'chat', transcript: '', tags: ['日常'], max: 2, already: ['x'] })).toContain('用戶不在場');
    });
    it('原話要真的在那則裡，對不上就取那則開頭；tag 不在清單換成第一個', () => {
        const msgs = [msg(1, 'user', '今天終於接回你的訊號了，好累'), msg(2, 'assistant', '辛苦了')];
        const raw = '```json\n{"pick":[{"n":1,"quote":"終於接回你的訊號了","tag":"心動","note":"「她回來了。」"},{"n":2,"quote":"亂寫的","tag":"亂","note":"鬆了口氣"},{"n":9,"note":"x"}]}\n```';
        const out = parseFragmentPick(raw, msgs, fragmentTagsFor('romance'));
        expect(out).toHaveLength(2);
        expect(out[0]).toMatchObject({ tag: '心動', quote: '終於接回你的訊號了', note: '她回來了。' });
        expect(out[1]).toMatchObject({ tag: '日常', quote: '辛苦了' });
        expect(settleQuote('', 'a'.repeat(80))).toHaveLength(61);
        expect(parseFragmentPick('[{"n":2,"note":"好"}]', msgs, ['日常'])[0].msg.id).toBe(2);
        expect(parseFragmentPick('沒有', msgs, ['日常'])).toEqual([]);
    });
    it('tag 顏色', () => {
        expect(tagTone('里程碑')).toBe('cherry');
        expect(tagTone('心動')).toBe('cranberry');
        expect(tagTone('爭執')).toBe('mauve');
        expect(tagTone('日常')).toBe('blush');
    });
});

describe('拾光片段：卡、清空、進提示詞', () => {
    const src = { type: 'message' as const, lineId: 'c1', messageIds: [1], snippet: 's', at: 1 };
    const frag = (over: Partial<Parameters<typeof newFragmentEntry>[0]> = {}) => newFragmentEntry({ bondId: 'b', dayKey: '2026-11-16', tag: '日常', note: '她回來了', quote: { who: 'user', text: '我回來了' }, voice: 'c1', time: '10:00', at: 5, from: 'chat', source: src, ...over });
    it('片段是 AI 寫的 moment；清空只清片段、某一天只算那天', () => {
        const f = frag();
        expect(f).toMatchObject({ kind: 'moment', createdBy: 'ai', author: 'c1', status: 'published', eventDate: { precision: 'day', date: '2026-11-16' } });
        const mine = { ...f, id: 'm', fragment: undefined, createdBy: 'user' as const };
        expect(clearableFragments([f, mine]).map(e => e.id)).toEqual([f.id]);
        expect(fragmentsOfDay([f, frag({ dayKey: '2026-11-17' })], '2026-11-16')).toHaveLength(1);
    });
    it('收藏的一定進、再加最近的；提示詞寫成時刻＋心裡話＋原話', () => {
        const old = { ...frag({ dayKey: '2020-01-01' }), favorite: true };
        const many = Array.from({ length: 14 }, (_, i) => frag({ dayKey: `2026-11-${String(i + 1).padStart(2, '0')}` }));
        const picked = promptMoments([old, ...many]);
        expect(picked).toHaveLength(13);
        expect(picked.some(e => e.id === old.id)).toBe(true);
        const out = bondPromptBlock({ bond: undefined, selfName: 'Sully', otherName: 'Liora', entries: [frag()], selfId: 'c1' });
        expect(out).toContain('2026-11-16 10:00｜[日常] 你當時想：她回來了；Liora說：「我回來了」');
    });
    it('角色之間：別人的心裡話不進提示詞，只帶原話', () => {
        const other = frag({ voice: 'c2', quote: { who: 'c2', text: '早' } });
        const out = bondPromptBlock({ bond: undefined, selfName: 'A', otherName: 'B', entries: [other], selfId: 'c1', includeUserNotes: false, pair: { selfId: 'c1', otherId: 'c2', isA: true } });
        expect(out).toContain('[日常] B說：「早」');
        expect(out).not.toContain('她回來了');
    });
});
