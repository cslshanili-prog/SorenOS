import { describe, expect, it } from 'vitest';
import {
    buildStoryExtractPrompt, buildStoryPersonalPrompt, countBucket, defaultChecked, parseStoryExtract, parseStoryPersonal, planStoryWriteback,
    storyCandidates, storyPalaceContent, type StoryExtract,
} from './storyExtract';

const empty: StoryExtract = { moments: [], milestones: [], wishes: [], promises: [], habits: [], gifts: [], letters: [] };

describe('故事回寫：抽取', () => {
    it('提示詞：路線篩過的里程碑清單、已經記過的、A／B 是誰', () => {
        const p = buildStoryExtractPrompt({ aName: 'Sully', bName: 'Mio', title: '雨', text: '正文', route: 'friendship', known: { gifts: ['圍巾'] } });
        expect(p).toContain('A＝Sully，B＝Mio');
        expect(p).not.toContain('together＝');
        expect(p).toContain('禮物：圍巾');
        expect(p).toContain('【故事】\n正文');
    });

    it('解析：名字或 A／B 都認、壞的單項丟掉、超過上限截斷、重複去掉', () => {
        const raw = '```json\n' + JSON.stringify({
            moments: [{ title: '傘', text: 'Sully 把傘給了 Mio' }, { title: '', text: 'Sully 把傘給了 Mio' }, { text: '' }],
            milestones: [{ what: 'together', text: '告白成功' }, { what: '一起旅行', text: 'x' }, { what: 'custom' }],
            wishes: [{ owner: 'Mio', text: '想去看海' }, { owner: '路人', text: '丟掉' }, { owner: 'both', text: '一起養貓' }],
            promises: [{ text: '每週一起吃飯', repeat: 'weekly' }, { text: '下次見', repeat: '奇怪' }],
            habits: [{ text: '晚安前互傳一張照片' }],
            gifts: [{ from: 'B', title: '圍巾', occasion: '生日' }, { from: 'A' }],
            letters: [{ from: 'Sully', about: '道歉' }],
        }) + '\n```';
        const ex = parseStoryExtract(raw, 'Sully', 'Mio')!;
        expect(ex.moments).toEqual([{ title: '傘', text: 'Sully 把傘給了 Mio' }]);
        expect(ex.milestones).toEqual([{ what: 'together', text: '告白成功' }, { what: 'custom', label: '一起旅行', text: 'x' }]);
        expect(ex.wishes).toEqual([{ owner: 'b', text: '想去看海' }, { owner: 'both', text: '一起養貓' }]);
        expect(ex.promises.map(p => p.repeat.kind)).toEqual(['weekly', 'once']);
        expect(ex.gifts).toEqual([{ from: 'b', title: '圍巾', occasion: '生日', text: '圍巾' }]);
        expect(ex.letters).toEqual([{ from: 'a', about: '道歉' }]);
        expect(parseStoryExtract('不是 JSON', 'A', 'B')).toBeNull();
    });
});

describe('故事回寫：清單', () => {
    it('會改階段的帶 sync；路線不允許的丟掉；已經是那個階段、記過的不重複', () => {
        const ex: StoryExtract = { ...empty, milestones: [{ what: 'together', text: '在一起' }, { what: 'firstDate', text: '約會' }, { what: 'reconciled', text: '和好' }] };
        const romance = storyCandidates(ex, { route: 'romance', stage: 'crush' });
        expect(romance.map(i => i.kind === 'milestone' && [i.what, !!i.sync])).toEqual([['together', true], ['firstDate', false], ['reconciled', true]]);
        const friend = storyCandidates(ex, { route: 'friendship', stage: 'friend' });
        expect(friend.map(i => i.kind === 'milestone' && i.what)).toEqual(['reconciled']);
        const already = storyCandidates(ex, { route: 'romance', stage: 'lovers', knownWhats: ['together', 'firstDate'] });
        expect(already.map(i => i.kind === 'milestone' && i.what)).toEqual(['reconciled']);
        const unset = storyCandidates({ ...empty, milestones: [{ what: 'together', text: '' }] }, { stage: 'friend' });
        expect(unset[0]).toMatchObject({ sync: { stageTo: 'lovers', routeTo: 'romance' } });
    });

    it('預設全勾；自動日記關掉時日記不勾', () => {
        const items = [
            { key: 'm', kind: 'moment' as const, title: '', text: 'x' },
            { key: 'd', kind: 'diary' as const, side: 'a' as const, text: 'y' },
        ];
        expect([...defaultChecked(items, true)]).toEqual(['m', 'd']);
        expect([...defaultChecked(items, false)]).toEqual(['m']);
    });
});

describe('故事回寫：寫成卡', () => {
    const ctx = { bondId: 'pair~a~b', storyId: 's1', aId: 'a', bId: 'b', eventDate: { precision: 'day' as const, date: '2026-11-27' }, now: 10 };

    it('每種寫成對的卡、來源都是這一章；約定與默契直接成立；禮物方向照送的人', () => {
        const plan = planStoryWriteback([
            { key: '1', kind: 'moment', title: '傘', text: '給了傘' },
            { key: '2', kind: 'milestone', what: 'firstDate', text: '約會' },
            { key: '3', kind: 'milestone', what: 'together', text: '在一起', sync: { stageTo: 'lovers' } },
            { key: '4', kind: 'wish', owner: 'b', text: '看海' },
            { key: '5', kind: 'promise', text: '每週吃飯', repeat: { kind: 'weekly' } },
            { key: '6', kind: 'habit', text: '互傳照片' },
            { key: '7', kind: 'gift', from: 'b', title: '圍巾', text: '圍巾' },
            { key: '8', kind: 'letter', from: 'a', about: '道歉', text: '對不起……' },
            { key: '9', kind: 'letter', from: 'b', about: '沒寫出來', text: '' },
            { key: '10', kind: 'diary', side: 'b', text: '今天……' },
            { key: '11', kind: 'memory', side: 'a', text: '我記得那把傘' },
        ], ctx);
        expect(plan.entries.map(e => e.kind)).toEqual(['moment', 'milestone', 'wish', 'promise', 'habit', 'gift', 'letter', 'diary']);
        expect(plan.entries.every(e => e.sources[0]?.type === 'story' && (e.sources[0] as any).entryId === 's1')).toBe(true);
        expect(plan.entries.every(e => e.eventDate.precision === 'day')).toBe(true);
        const [, ms, wish, promise, habit, gift, letter, diary] = plan.entries;
        expect(ms.milestone).toMatchObject({ what: 'firstDate', via: 'story' });
        expect(wish).toMatchObject({ status: 'published', author: 'b', wish: { owner: 'b', state: 'want' } });
        expect(promise.promise).toMatchObject({ state: 'active', participants: ['a', 'b'] });
        expect(habit.habit?.state).toBe('active');
        expect(gift.gift).toMatchObject({ dir: 'in', state: 'given' });
        expect(gift.author).toBe('b');
        expect(letter.letter).toMatchObject({ to: 'b', origin: 'story', sentAt: 10, arrivedAt: 10, readAt: 10 });
        expect(diary).toMatchObject({ kind: 'diary', author: 'b', diary: { date: '2026-11-27' } });
        expect(plan.proposals).toEqual([{ what: 'together', stageTo: 'lovers', date: '2026-11-27', text: '在一起', source: 'story', evidence: { storyId: 's1' }, key: 'story:s1:together' }]);
        expect(plan.memories).toEqual([{ side: 'a', text: '我記得那把傘' }]);
    });

    it('各自那份：日記可以不要、解析、記憶宮殿寫法、分檔', () => {
        expect(buildStoryPersonalPrompt({ selfName: 'A', otherName: 'B', title: 't', text: 'x', diary: false })).not.toContain('diary');
        expect(buildStoryPersonalPrompt({ selfName: 'A', otherName: 'B', title: 't', text: 'x', diary: true })).toContain('"diary"');
        expect(parseStoryPersonal('{"memory":"我記得","diary":"今天"}')).toEqual({ memory: '我記得', diary: '今天' });
        expect(parseStoryPersonal('{}')).toBeNull();
        expect(storyPalaceContent('Mio', ' 那天 ')).toBe('〔這是你跟「Mio」之間發生的事，用戶不在場〕那天');
        expect([countBucket(0), countBucket(1), countBucket(5)]).toEqual(['0', '1', '2+']);
    });
});

describe('故事回寫：刪改一章', async () => {
    const { storyDerivatives, planStoryRetract, planDerivedRemoval } = await import('./derivation');
    const { newStoryEntry } = await import('./story');
    const story = { ...newStoryEntry({ bondId: 'pair~a~b', chapter: 1, title: 't', text: 'x', summary: 's', pov: 'narrator' }), id: 's1' };
    story.story = { ...story.story!, derived: { topics: [{ charId: 'a', topicId: 't1' }], palace: [{ charId: 'b', nodeId: 'n1' }] } };
    const plan = planStoryWriteback([
        { key: '1', kind: 'moment', title: '', text: '片刻' },
        { key: '2', kind: 'wish', owner: 'a', text: '願望' },
    ], { bondId: 'pair~a~b', storyId: 's1', aId: 'a', bId: 'b', eventDate: { precision: 'unknown' }, now: 1 });
    const [moment, wish] = plan.entries;
    const both = { ...wish, sources: [...wish.sources, { type: 'memory' as const, charId: 'a', memoryId: 'm' }] };
    const essay = { ...moment, id: 'essay1', kind: 'essay' as const, sources: [], links: [{ type: 'entry' as const, id: moment.id }] };
    const all = [story, moment, both, essay];

    it('列出長出來的、建在上面的、話題盒、記憶宮殿、承認卡', () => {
        const d = storyDerivatives(all, story, [{ id: 'p', what: 'together', text: '', source: 'story', evidence: { storyId: 's1' }, key: 'k', at: 1 }]);
        expect(d.entries.map(e => e.id)).toEqual([moment.id, both.id]);
        expect(d.dependents.map(e => e.id)).toEqual(['essay1']);
        expect(d.topics).toHaveLength(1);
        expect(d.palace).toHaveLength(1);
        expect(d.proposals).toHaveLength(1);
    });

    it('一起刪：另有來源的留著拆關聯；留著：全部拆關聯', () => {
        const c = planStoryRetract(all, story, 'cascade', 5);
        expect(c.deleteIds.sort()).toEqual(['essay1', moment.id, 's1'].sort());
        expect(c.updates.map(e => [e.id, e.sources.length, e.orphanedLinks])).toEqual([[both.id, 1, [{ type: 'entry', id: 's1' }]]]);
        const d = planStoryRetract(all, story, 'detach', 5);
        expect(d.deleteIds).toEqual(['s1']);
        expect(d.updates.map(e => e.id)).toEqual([moment.id, both.id]);
    });

    it('重新整理：只刪勾的（連同建在上面的）', () => {
        const r = planDerivedRemoval(all, story, [moment.id], 5);
        expect(r.deleteIds.sort()).toEqual(['essay1', moment.id].sort());
        expect(r.updates).toEqual([]);
    });
});
