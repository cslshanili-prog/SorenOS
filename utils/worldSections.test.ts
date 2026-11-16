import { describe, it, expect } from 'vitest';
import { groupForSwitcher, matchesSearch, recentChars, sectionOf } from './worldSections';

const worlds = [
    { id: 'w1', name: '霧城', sections: [{ id: 's1', name: '林家' }, { id: 's2', name: '白家' }] },
    { id: 'w2', name: '學院' },
] as any[];
const c = (id: string, extra: any = {}) => ({ id, name: id, avatar: '', description: '', systemPrompt: '', memories: [], ...extra }) as any;

describe('世界底下的分組', () => {
    it('分組只在自己的世界裡算；被刪或換世界就當沒分組', () => {
        expect(sectionOf(c('a', { groupId: 'w1', worldSectionId: 's1' }), worlds)?.name).toBe('林家');
        expect(sectionOf(c('a', { groupId: 'w2', worldSectionId: 's1' }), worlds)).toBeUndefined();
        expect(sectionOf(c('a', { groupId: 'w1', worldSectionId: 'gone' }), worlds)).toBeUndefined();
    });

    it('照世界 → 分組排；沒分組放世界最後、沒世界放最後；主角在前配角在後', () => {
        const chars = [
            c('x'), c('lin2', { groupId: 'w1', worldSectionId: 's1', castRole: 'supporting' }),
            c('lin1', { groupId: 'w1', worldSectionId: 's1' }), c('bai', { groupId: 'w1', worldSectionId: 's2' }),
            c('loose', { groupId: 'w1' }), c('stu', { groupId: 'w2' }), c('ghost', { groupId: 'deleted' }),
        ];
        const out = groupForSwitcher(chars, worlds);
        expect(out.map(w => w.world?.name ?? '沒有世界')).toEqual(['霧城', '學院', '沒有世界']);
        const w1 = out[0];
        expect(w1.count).toBe(4);
        expect(w1.sections.map(s => s.section?.name ?? '其他')).toEqual(['林家', '白家', '其他']);
        expect(w1.sections[0].chars.map(x => x.id)).toEqual(['lin1', 'lin2']);
        expect(out[2].sections[0].chars.map(x => x.id)).toEqual(['x', 'ghost']);
    });

    it('沒人的世界、沒人的分組不列', () => {
        const out = groupForSwitcher([c('stu', { groupId: 'w2' })], worlds);
        expect(out).toHaveLength(1);
        expect(out[0].sections).toHaveLength(1);
    });

    it('搜尋比對名字、暱稱、簡介、世界、分組，不分繁簡和空白', () => {
        const lin = c('林曉', { groupId: 'w1', worldSectionId: 's1', chatNickname: '小曉', description: '刑警' });
        expect(matchesSearch(lin, '林家', worlds)).toBe(true);
        expect(matchesSearch(lin, '霧城', worlds)).toBe(true);
        expect(matchesSearch(lin, '小 曉', worlds)).toBe(true);
        expect(matchesSearch(lin, '刑警', worlds)).toBe(true);
        expect(matchesSearch(lin, '晓', worlds)).toBe(true);
        expect(matchesSearch(lin, '白家', worlds)).toBe(false);
        expect(matchesSearch(lin, '', worlds)).toBe(true);
    });

    it('最近聊過照最後一則訊息新到舊，沒聊過的不列', () => {
        const list = [c('a'), c('b'), c('d')];
        expect(recentChars(list, { a: 10, b: 30 }).map(x => x.id)).toEqual(['b', 'a']);
        expect(recentChars(list, { a: 10, b: 30, d: 20 }, 2).map(x => x.id)).toEqual(['b', 'd']);
    });
});
