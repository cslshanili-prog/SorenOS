import { describe, expect, it } from 'vitest';
import type { BondEntry, MemoryFragment } from '../../types';
import { buildTimeline } from './timeline';
import {
    afterLines, buildAfterwordPrompt, buildEssayChoosePrompt, buildEssayPrompt, essayCandidates, essayDraft, essayRoot,
    essayTargetOf, essayThread, linkForItem, parseEssay, reviseEssay, rewriteDraft, visibleToWriter,
} from './essay';
import { promptEssays } from './prompt';

const entry = (over: Partial<BondEntry>): BondEntry => ({
    id: over.id || `e${Math.random()}`, bondId: 'c1::p1', kind: 'moment', author: 'user', text: '一起看了海',
    eventDate: { precision: 'day', date: '2026-05-01' }, writtenAt: 1000, sources: [], links: [], status: 'published',
    createdBy: 'user', updatedAt: 1000, ...over,
});
const mem = (id: string, date: string, summary = `記憶 ${id}`): MemoryFragment => ({ id, date, summary });

const moment = entry({
    id: 'mo1', title: '海邊', text: '晚上一起去海邊走走', note: '他記得我怕冷',
    sources: [{ type: 'message', lineId: 'c1', messageIds: [1, 2], snippet: 'Liora：去海邊\nSully：我帶外套', at: 1 }],
});
const timeline = () => buildTimeline({
    bond: undefined,
    entries: [moment],
    memories: { charId: 'c1', list: [mem('m0', '2026-04-20', '剛認識'), mem('m1', '2026-05-03', '一起吃烤魷魚'), mem('m2', '2026-05-10', '吵了一架又和好')] },
});

describe('隨筆寫的那件事', () => {
    it('片刻帶原文快照，你補的那句看空間決定帶不帶', () => {
        const item = timeline().find(i => i.key === 'e:mo1')!;
        const t = essayTargetOf(item, { includeUserNote: true });
        expect(t.title).toBe('海邊');
        expect(t.note).toBe('他記得我怕冷');
        expect(t.snippet).toContain('我帶外套');
        expect(essayTargetOf(item, { includeUserNote: false }).note).toBeUndefined();
    });
    it('之後發生的事：只列比它晚的記憶，舊到新', () => {
        const items = timeline();
        const item = items.find(i => i.key === 'e:mo1')!;
        const out = afterLines(items, item);
        expect(out.split('\n')).toHaveLength(2);
        expect(out.indexOf('烤魷魚')).toBeLessThan(out.indexOf('吵了一架'));
        expect(out).not.toContain('剛認識');
    });
    it('角色之間：對方整理的話題盒不給寫的人看', () => {
        const items = buildTimeline({ bond: undefined, entries: [], topics: [
            { ownerId: 'a', partnerId: 'b', list: [{ id: 't1', text: 'A 的整理', createdAt: 1 } as any] },
            { ownerId: 'b', partnerId: 'a', list: [{ id: 't2', text: 'B 的整理', createdAt: 2 } as any] },
        ] });
        expect(visibleToWriter(items, 'a').map(i => i.text)).toEqual(['A 的整理']);
    });
});

describe('提示詞', () => {
    const item = timeline().find(i => i.key === 'e:mo1')!;
    const target = essayTargetOf(item, { includeUserNote: true });
    it('指定一件事：寫感想不寫事實、輸出 JSON', () => {
        const p = buildEssayPrompt({ selfName: 'Sully', otherName: 'Liora', target, after: '- 5 月 3 日：吃烤魷魚', hint: '寫那件外套' });
        expect(p).toContain('推測要寫成推測');
        expect(p).toContain('不要新增沒發生過的情節');
        expect(p).toContain('當時的原文');
        expect(p).toContain('寫那件外套');
        expect(p).toContain('{"title"');
    });
    it('讓 TA 挑：編號列出候選', () => {
        const p = buildEssayChoosePrompt({ selfName: 'Sully', otherName: 'Liora', candidates: [{ dateText: '5 月 1 日', label: '片刻', text: '海邊' }] });
        expect(p).toContain('#1（5 月 1 日・片刻）海邊');
        expect(p).toContain('"pick"');
    });
    it('後記：帶之前寫的，原文不改', () => {
        const p = buildAfterwordPrompt({ selfName: 'Sully', otherName: 'Liora', previous: [{ dateText: '5 月 2 日', text: '那天風很大' }] });
        expect(p).toContain('原文不改');
        expect(p).toContain('（寫於 5 月 2 日）那天風很大');
    });
});

describe('解析', () => {
    it('JSON（可以包在程式碼區塊裡）', () => {
        expect(parseEssay('```json\n{"title":"外套","text":"我只是剛好帶了。"}\n```', 'event')).toEqual({ title: '外套', text: '我只是剛好帶了。' });
        expect(parseEssay('{"pick":2,"title":"","text":"寫第二件"}', 'choose')).toEqual({ pick: 2, text: '寫第二件', title: undefined });
    });
    it('不是 JSON：指定的當正文，挑的算失敗', () => {
        expect(parseEssay('「其實我記得。」', 'event')).toEqual({ text: '其實我記得。' });
        expect(parseEssay('其實我記得', 'choose')).toBeNull();
        expect(parseEssay('{"text":"沒編號"}', 'choose')).toBeNull();
        expect(parseEssay('', 'event')).toBeNull();
    });
});

describe('卡片', () => {
    const items = timeline();
    const item = items.find(i => i.key === 'e:mo1')!;
    it('草稿：指向那件事、日期跟著事件、草稿不進提示詞', () => {
        const d = essayDraft({ bondId: 'c1::p1', writerId: 'c1', item, parsed: { text: '我記得', title: '外套' }, now: 5 });
        expect(d).toMatchObject({ kind: 'essay', author: 'c1', status: 'draft', createdBy: 'ai', links: [{ type: 'entry', id: 'mo1' }], eventDate: moment.eventDate });
        expect(promptEssays([d], 'c1')).toEqual([]);
        expect(promptEssays([{ ...d, status: 'published' }], 'c1')).toHaveLength(1);
        // 時間線上掛到那件事底下
        expect(buildTimeline({ bond: undefined, entries: [moment, d] }).find(i => i.key === 'e:mo1')!.essays).toHaveLength(1);
    });
    it('記憶的關聯', () => {
        expect(linkForItem(items.find(i => i.key === 'm:m1')!)).toEqual([{ type: 'memory', charId: 'c1', memoryId: 'm1' }]);
    });
    it('候選：寫過的、收起的不列', () => {
        const d = { ...essayDraft({ bondId: 'c1::p1', writerId: 'c1', item, parsed: { text: 'x' } }), status: 'published' as const };
        const list = essayCandidates(buildTimeline({ bond: { memoryMarks: { m2: { hidden: true } } } as any, entries: [moment, d], memories: { charId: 'c1', list: [mem('m1', '2026-05-03'), mem('m2', '2026-05-10')] } }), 'c1');
        expect(list.map(i => i.key)).toEqual(['m:m1']);
    });
    it('編修：第一次改留原文，之後不覆蓋；重寫草稿不留', () => {
        const d = essayDraft({ bondId: 'b', writerId: 'c1', item, parsed: { text: '第一版' } });
        const r1 = reviseEssay(d, { text: '第二版' }, 10);
        expect(r1.originalText).toBe('第一版');
        expect(reviseEssay(r1, { text: '第三版' }, 11).originalText).toBe('第一版');
        expect(reviseEssay(r1, { text: '第二版' })).toBe(r1);
        expect(rewriteDraft(r1, { text: '重寫' }).originalText).toBeUndefined();
    });
    it('後記串：原隨筆在前，後記照寫下時間；從後記找得到原隨筆', () => {
        const root = { ...essayDraft({ bondId: 'b', writerId: 'c1', item, parsed: { text: '原' }, now: 1 }), id: 'r' };
        const a1 = { ...essayDraft({ bondId: 'b', writerId: 'c1', afterwordOf: root, parsed: { text: '後記一' }, now: 3 }), id: 'a1' };
        const a2 = { ...essayDraft({ bondId: 'b', writerId: 'c1', afterwordOf: a1, parsed: { text: '後記二' }, now: 5 }), id: 'a2' };
        expect(a1.afterwordOf).toBe('r');
        expect(a1.links).toEqual([]);
        expect(a1.eventDate).toEqual(root.eventDate);
        expect(essayThread([a2, root, a1], 'r').map(e => e.id)).toEqual(['r', 'a1', 'a2']);
        expect(essayRoot([a2, root, a1], 'a2')?.id).toBe('r');
    });
});
