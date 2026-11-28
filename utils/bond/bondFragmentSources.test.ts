import { describe, expect, it } from 'vitest';
import {
    dialogueMaterials, innerMaterials, lifeMaterials, materialsBlock, mentionNames, momentMaterials, numberMaterials, pickAround,
} from './fragmentSources';
import { buildFragmentPrompt, newFragmentEntry, parseFragmentPick } from './fragment';

const m = (id: number, role: 'user' | 'assistant', content: string, extra: any = {}) => ({ id, role, type: 'text', content, timestamp: id * 60_000, charId: 'c1', ...extra }) as any;
const timeOf = (ts: number) => `10:${String(Math.floor(ts / 60_000)).padStart(2, '0')}`;

describe('拾光多角度：素材', () => {
    it('認人的名字兩個字以上才比對；命中的前後各帶一則', () => {
        expect(mentionNames(['凌暄', '暄', ''])).toEqual(['凌暄']);
        expect(mentionNames(['U'])).toEqual(['U']);
        expect(pickAround([1, 2, 3, 4, 5, 6], x => x === 4, 1)).toEqual([3, 4, 5]);
        expect(pickAround([1, 2, 3], () => false)).toEqual([]);
    });
    it('群聊：沒提到你、你也沒說話就沒有；有的話帶群名、原話能跳回群', () => {
        const base = { angle: 'group' as const, context: '群「西湖」', nameOf: (x: any) => (x.role === 'user' ? '凌暄' : '小雨'), speakerIdOf: (x: any) => (x.role === 'user' ? 'user' : 'c9'), timeOf,
            sourceOf: (x: any, snippet: string) => ({ type: 'group' as const, groupId: 'g1', messageIds: [x.id], snippet, at: x.timestamp }) };
        const none = dialogueMaterials({ ...base, msgs: [m(1, 'assistant', '今天好冷'), m(2, 'assistant', '對啊')], isHit: x => x.content.includes('凌暄') });
        expect(none).toEqual([]);
        const got = dialogueMaterials({ ...base, msgs: [m(1, 'assistant', 'a'), m(2, 'assistant', 'b'), m(3, 'assistant', '凌暄今天怎麼沒來'), m(4, 'assistant', 'c'), m(5, 'assistant', 'd')], isHit: x => x.content.includes('凌暄') });
        expect(got.map(x => x.text)).toEqual(['b', '凌暄今天怎麼沒來', 'c']);
        expect(got[1]).toMatchObject({ context: '群「西湖」', quotable: true, speaker: '小雨', source: { type: 'group', groupId: 'g1', messageIds: [3] } });
    });
    it('TA 的一天：每段日程＋最後一段獨白；角色之間只留跟對方有關的', () => {
        const schedule = { slots: [
            { startTime: '08:00', activity: '晨跑', location: '河邊' },
            { startTime: '21:00', activity: '洗底片', innerThought: '想第一個講給她聽' },
        ], flowNarrative: { '08:00': '早上', '21:00': '晚上想她' } } as any;
        const all = lifeMaterials({ schedule, context: 'TA 的一天', atOf: () => 0 });
        expect(all.map(x => x.text)).toEqual(['晨跑（河邊）', '洗底片；心裡想：想第一個講給她聽', '晚上想她']);
        expect(all.every(x => !x.quotable)).toBe(true);
        const only = lifeMaterials({ schedule, context: '阿澈的一天', atOf: () => 0, onlyIf: t => t.includes('她') });
        expect(only).toHaveLength(2);
        expect(lifeMaterials({ schedule: null, context: 'x', atOf: () => 0 })).toEqual([]);
    });
    it('朋友圈：TA 那天發的；你發的、TA 那天留言的；角色之間要有對方互動', () => {
        const day = (ts: number) => (ts < 1000 ? 'd1' : 'd2');
        const self = (a: any) => a.kind === 'character' && a.id === 'c1';
        const other = (a: any) => a.kind === 'user';
        const posts = [
            { id: 'p1', author: { kind: 'character', id: 'c1', name: '阿澈' }, content: '拍到一隻貓', images: [], likes: [], comments: [], createdAt: 10 },
            { id: 'p2', author: { kind: 'user', id: 'user', name: '凌暄' }, content: '下雨了', images: [], likes: [], comments: [{ id: 'k', actor: { kind: 'character', id: 'c1', name: '阿澈' }, content: '帶傘', at: 20 }], createdAt: 5 },
            { id: 'p3', author: { kind: 'character', id: 'c2', name: '別人' }, content: 'x', images: [], likes: [], comments: [], createdAt: 10 },
        ] as any;
        const got = momentMaterials({ posts, dayKey: 'd1', dayOf: day, timeOf: () => '09:00', isSelf: self, isOther: other, selfName: '阿澈', otherName: '凌暄' });
        expect(got.map(x => x.text)).toEqual(['阿澈發：拍到一隻貓', '凌暄發：下雨了｜阿澈留言：帶傘']);
        expect(got[0].source).toMatchObject({ type: 'moment', postId: 'p1' });
        expect(momentMaterials({ posts, dayKey: 'd1', dayOf: day, timeOf: () => '09:00', isSelf: self, isOther: other, selfName: '阿澈', otherName: '凌暄', needOther: true })).toHaveLength(1);
    });
    it('心聲：只取 TA 回覆上記的那幾段', () => {
        const got = innerMaterials([m(1, 'user', 'a'), m(2, 'assistant', 'b', { metadata: { innerState: '她今天好安靜' } }), m(3, 'assistant', 'c')], timeOf);
        expect(got).toEqual([{ angle: 'inner', at: 120000, time: '10:02', text: '她今天好安靜', quotable: false }]);
    });
    it('編號照角度各自數，給 AI 看的區塊有小標', () => {
        const mats = numberMaterials([
            { angle: 'life', at: 2, time: '08:00', context: 'TA 的一天', text: '晨跑', quotable: false },
            { angle: 'group', at: 5, time: '09:00', context: '群「西湖」', speaker: '小雨', text: '凌暄呢', quotable: true },
            { angle: 'group', at: 1, time: '08:30', context: '群「西湖」', speaker: '凌暄', text: '我在', quotable: true },
        ]);
        expect(mats.map(x => x.ref)).toEqual(['G1', 'G2', 'L1']);
        const block = materialsBlock(mats, '阿澈', '凌暄');
        expect(block).toContain('【群聊（有原話可以引）】');
        expect(block).toContain('G2 [09:00] 群「西湖」 小雨：凌暄呢');
        expect(block).toContain('【你這天的日程和獨白（沒有原話）】');
    });
});

describe('拾光多角度：提示詞、解析、卡', () => {
    const mats = numberMaterials([
        { angle: 'group', at: 1, time: '08:30', context: '群「西湖」', speaker: '小雨', speakerId: 'c9', text: '凌暄今天怎麼沒來', quotable: true, source: { type: 'group', groupId: 'g1', messageIds: [7], snippet: 'x', at: 1 } },
        { angle: 'life', at: 2, time: '21:00', context: 'TA 的一天', text: '洗底片', quotable: false },
    ]);
    it('有素材時多一段角度規則；沒對話時改寫 ref', () => {
        const p = buildFragmentPrompt({ selfName: '阿澈', otherName: '凌暄', dayLabel: 'd', from: 'chat', transcript: '#1 [10:00] 凌暄：早', tags: ['日常'], max: 3, materials: materialsBlock(mats, '阿澈', '凌暄') });
        expect(p).toContain('對話引文不要超過一半');
        expect(p).toContain('G1 [08:30]');
        const q = buildFragmentPrompt({ selfName: '阿澈', otherName: '凌暄', dayLabel: 'd', from: 'chat', transcript: '', tags: ['日常'], max: 2, materials: 'L1 x' });
        expect(q).toContain('沒有私聊，但這天有這些');
        expect(q).toContain('- ref：素材的編號');
        const plain = buildFragmentPrompt({ selfName: '阿澈', otherName: '凌暄', dayLabel: 'd', from: 'chat', transcript: '#1 x', tags: ['日常'], max: 2 });
        expect(plain).not.toContain('ref');
    });
    it('解析：n 是對話、ref 是素材；沒原話的素材 quote 留空；同一個 ref 不重複', () => {
        const msgs = [m(1, 'user', '早安呀')];
        const raw = '{"pick":[{"n":1,"quote":"早安","tag":"日常","note":"她醒了"},{"ref":"G1","quote":"今天怎麼沒來","tag":"日常","note":"被問到她"},{"ref":"l1","quote":"亂寫","tag":"日常","note":"想說給她聽"},{"ref":"G1","note":"重複"},{"ref":"X9","note":"沒這個"}]}';
        const picks = parseFragmentPick(raw, msgs, ['日常'], 6, mats);
        expect(picks).toHaveLength(3);
        expect(picks[0].msg?.id).toBe(1);
        expect(picks[1]).toMatchObject({ quote: '今天怎麼沒來', material: { ref: 'G1' } });
        expect(picks[2]).toMatchObject({ quote: '', material: { ref: 'L1' } });
    });
    it('沒有可跳回的素材，卡的來源是空的；角度與小標記在 fragment', () => {
        const e = newFragmentEntry({ bondId: 'b', dayKey: '2026-11-07', tag: '日常', note: '洗底片時想到她', voice: 'c1', at: 2, from: 'life', context: 'TA 的一天' });
        expect(e.sources).toEqual([]);
        expect(e.fragment).toMatchObject({ from: 'life', context: 'TA 的一天' });
        expect(e.fragment!.quote).toBeUndefined();
    });
});
