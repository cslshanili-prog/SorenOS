import { describe, expect, it } from 'vitest';
import type { BondEntry, BondRecord, MemoryFragment } from '../../types';
import { eventDateFromText, eventMonthKey, eventSortKey, formatEventDate, promptEventDate } from './eventDate';
import { buildTimeline, filterTimeline, memoriesForLine, pickRecentItem, sortTimeline } from './timeline';
import { dependentsOf, planRetract } from './derivation';
import { bondPromptBlock, promptEssays, promptMoments, PROMPT_MOMENT_LIMIT } from './prompt';
import { blankBond } from './model';

const entry = (over: Partial<BondEntry>): BondEntry => ({
    id: over.id || `e${Math.random()}`, bondId: 'c1::p1', kind: 'moment', author: 'user', text: '一起看了海',
    eventDate: { precision: 'day', date: '2026-05-01' }, writtenAt: 1000, sources: [], links: [], status: 'published',
    createdBy: 'user', updatedAt: 1000, ...over,
});
const mem = (id: string, date: string, personaKey?: string): MemoryFragment => ({ id, date, summary: `記憶 ${id}`, personaKey });

describe('事件日期', () => {
    it('從記憶的日期字串讀精度', () => {
        expect(eventDateFromText('2026-05-01')).toEqual({ precision: 'day', date: '2026-05-01' });
        expect(eventDateFromText('2026年5月3日 晚上')).toEqual({ precision: 'day', date: '2026-05-03' });
        expect(eventDateFromText('2026/5')).toEqual({ precision: 'month', date: '2026-05' });
        expect(eventDateFromText('unknown')).toEqual({ precision: 'unknown' });
        expect(eventDateFromText('2026-13-01')).toEqual({ precision: 'unknown' });
    });
    it('排序鍵：只到月的排在那個月有確切日期的後面（較舊），不明的最舊', () => {
        const keys = [
            eventSortKey({ precision: 'day', date: '2026-05-02' }),
            eventSortKey({ precision: 'month', date: '2026-05' }),
            eventSortKey({ precision: 'unknown' }),
            eventSortKey({ precision: 'period', label: '剛認識那陣子' }),
        ];
        expect(keys).toEqual(['2026-05-02', '2026-05-00', '', '']);
        expect(eventMonthKey({ precision: 'month', date: '2026-05' })).toBe('2026-05');
        expect(eventMonthKey({ precision: 'unknown' })).toBe('');
    });
    it('顯示：不捏造精確日期', () => {
        expect(formatEventDate({ precision: 'month', date: '2026-05' })).toBe('2026 年 5 月某天');
        expect(formatEventDate({ precision: 'period', label: '春天' })).toBe('春天');
        expect(promptEventDate({ precision: 'month', date: '2026-05' })).toBe('2026-05（哪天不確定）');
        expect(promptEventDate({ precision: 'unknown' })).toBe('日期不明');
    });
});

describe('記憶照線篩', () => {
    const list = [mem('a', '2026-05-01'), mem('b', '2026-05-02', 'p1'), mem('c', '2026-05-03', 'p2')];
    it('主線的卡收寫了自己鍵的＋沒寫鍵的舊記憶', () => {
        expect(memoriesForLine(list, 'p1', 'p1').map(m => m.id)).toEqual(['a', 'b']);
    });
    it('別條線只收自己的，不混主線的舊記憶', () => {
        expect(memoriesForLine(list, 'p2', 'p1').map(m => m.id)).toEqual(['c']);
    });
    it('舊角色沒有身份卡鍵：收沒寫鍵的', () => {
        expect(memoriesForLine(list, undefined, undefined).map(m => m.id)).toEqual(['a']);
    });
});

describe('時間線', () => {
    const bond: BondRecord = { ...blankBond('c1::p1'), memoryMarks: { m2: { favorite: true }, m3: { hidden: true } } };
    const moment = entry({ id: 'x', eventDate: { precision: 'day', date: '2026-05-05' }, writtenAt: 5 });
    const essay = entry({ id: 'y', kind: 'essay', author: 'c1', links: [{ type: 'entry', id: 'x' }], status: 'draft' });
    const afterword = entry({ id: 'z', kind: 'essay', author: 'c1', afterwordOf: 'y' });
    const items = buildTimeline({
        bond, entries: [moment, essay, afterword],
        memories: { charId: 'c1', list: [mem('m1', '2026-05-01'), mem('m2', '2026-05-07'), mem('m3', '2026-04-01')] },
    });
    it('片刻和記憶照事件日期新到舊排', () => {
        expect(items.map(i => i.key)).toEqual(['m:m2', 'e:x', 'm:m1', 'm:m3']);
    });
    it('隨筆和它的後記掛在寫的那件事底下', () => {
        expect(items.find(i => i.key === 'e:x')?.essays.map(e => e.id).sort()).toEqual(['y', 'z']);
    });
    it('記憶的收藏、收起讀 memoryMarks', () => {
        expect(items.find(i => i.key === 'm:m2')?.favorite).toBe(true);
        expect(filterTimeline(items, 'all', false).map(i => i.key)).not.toContain('m:m3');
        expect(filterTimeline(items, 'all', true).map(i => i.key)).toContain('m:m3');
        expect(filterTimeline(items, 'moment', false).map(i => i.key)).toEqual(['e:x']);
    });
    it('首頁最近拾光：收藏優先', () => {
        expect(pickRecentItem(items)?.key).toBe('m:m2');
    });
    it('同一天後寫的在前', () => {
        expect(sortTimeline([{ sortKey: 'a', tieBreak: 1, id: 1 }, { sortKey: 'a', tieBreak: 2, id: 2 }]).map(x => x.id)).toEqual([2, 1]);
    });
});

describe('撤回對齊', () => {
    const moment = entry({ id: 'x' });
    const essay = entry({ id: 'y', kind: 'essay', author: 'c1', links: [{ type: 'entry', id: 'x' }] });
    const afterword = entry({ id: 'z', kind: 'essay', author: 'c1', afterwordOf: 'y' });
    const onMemory = entry({ id: 'w', kind: 'essay', author: 'c1', links: [{ type: 'memory', charId: 'c1', memoryId: 'm1' }] });
    const all = [moment, essay, afterword, onMemory];
    it('列出一路依賴的卡', () => {
        expect(dependentsOf(all, { type: 'entry', id: 'x' }).map(e => e.id).sort()).toEqual(['y', 'z']);
        expect(dependentsOf(all, { type: 'memory', memoryId: 'm1' }).map(e => e.id)).toEqual(['w']);
    });
    it('一起刪：連同依賴的卡', () => {
        expect(planRetract(all, { type: 'entry', id: 'x' }, 'cascade').deleteIds.sort()).toEqual(['x', 'y', 'z']);
    });
    it('留著：拆掉關聯、標成孤兒，不悄悄消失', () => {
        const plan = planRetract(all, { type: 'entry', id: 'x' }, 'detach', 9);
        expect(plan.deleteIds).toEqual(['x']);
        expect(plan.updates.map(e => e.id)).toEqual(['y']);
        expect(plan.updates[0].links).toEqual([]);
        expect(plan.updates[0].orphanedLinks).toEqual([{ type: 'entry', id: 'x' }]);
    });
    it('刪隨筆、留後記：後記變成獨立一篇', () => {
        const plan = planRetract(all, { type: 'entry', id: 'y' }, 'detach');
        expect(plan.updates[0].id).toBe('z');
        expect(plan.updates[0].afterwordOf).toBeUndefined();
    });
    it('刪記憶只拆關聯（記憶不是卡，不在刪除清單）', () => {
        const plan = planRetract(all, { type: 'memory', memoryId: 'm1' }, 'detach');
        expect(plan.deleteIds).toEqual([]);
        expect(plan.updates[0].orphanedLinks).toEqual([{ type: 'memory', charId: 'c1', memoryId: 'm1' }]);
    });
});

describe('提示詞：片刻與隨筆', () => {
    const bond = blankBond('c1::p1');
    it('沒有卡、全預設：空字串（跟第 1 批一字不差）', () => {
        expect(bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora' })).toBe('');
        expect(bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' })).toBe('');
        expect(bondPromptBlock({ bond: undefined, selfName: 'Sully', otherName: 'Liora', entries: [] })).toBe('');
    });
    it('有空間設定、沒有卡：跟第 1 批一字不差', () => {
        const b: BondRecord = { ...bond, route: 'friendship' };
        expect(bondPromptBlock({ bond: b, selfName: 'Sully', otherName: 'Liora', entries: [], selfId: 'c1' }))
            .toBe(bondPromptBlock({ bond: b, selfName: 'Sully', otherName: 'Liora' }));
    });
    it('空間沒存過也帶片刻', () => {
        const out = bondPromptBlock({ bond: undefined, selfName: 'Sully', otherName: 'Liora', entries: [entry({ title: '海邊', note: '那天很開心' })], selfId: 'c1' });
        expect(out).toContain('### 你和Liora的關係');
        expect(out).toContain('你們收存的片刻（實際發生過的事');
        expect(out).toContain('  - 2026-05-01｜海邊：一起看了海（Liora想留著它，因為：那天很開心）');
    });
    it('收起的、草稿不進；最多 8 則', () => {
        const many = Array.from({ length: 10 }, (_, i) => entry({ id: `m${i}`, writtenAt: i }));
        expect(promptMoments([...many, entry({ id: 'h', hidden: true })]).length).toBe(PROMPT_MOMENT_LIMIT);
        expect(promptMoments([entry({ status: 'draft' })])).toEqual([]);
    });
    it('隨筆只帶自己寫的、已收下的，標成感想', () => {
        const mine = entry({ id: 'a', kind: 'essay', author: 'c1', text: '我猜她那天有點失望' });
        const draft = entry({ id: 'b', kind: 'essay', author: 'c1', status: 'draft' });
        const other = entry({ id: 'c', kind: 'essay', author: 'c2' });
        expect(promptEssays([mine, draft, other], 'c1').map(e => e.id)).toEqual(['a']);
        const out = bondPromptBlock({ bond, selfName: 'Sully', otherName: 'Liora', entries: [mine, draft, other], selfId: 'c1' });
        expect(out).toContain('你寫過的隨筆（是你當時的感想，不是事實');
        expect(out).toContain('我猜她那天有點失望');
    });
    it('角色 × 角色：你補的那句不帶', () => {
        const out = bondPromptBlock({ bond: undefined, selfName: 'A', otherName: 'B', entries: [entry({ note: '秘密' })], selfId: 'a', includeUserNotes: false });
        expect(out).not.toContain('秘密');
    });
});
