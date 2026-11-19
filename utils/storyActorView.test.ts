import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { buildStoryActorPresenceNote, buildStoryKnownPeopleNote, focalStoryKey, storyActorLineView, storyActorPresence, storyPresentLinkLines } from './storyActorView';
import { buildStoryActorMemoryEnvelope, formatActorRecentMessages } from './storyTheater';
import { lineViewPersonaKey, resolveUserProfileForChar } from './userPersona';
import { memoryLineLabelsFor } from './memoryPalace/lineLabels';

// 劇情裡每個演員怎麼看在場的你（plans/story-multi-persona.md 第 2 批）

const base = {
    name: 'Liora', avatar: '', bio: '真實的我',
    personas: [
        { id: 'sis', name: '妹妹', avatar: '', bio: '大學生' },
        { id: 'elder', name: '姊姊', avatar: '', bio: '上班族' },
        { id: 'guest', name: '表妹', avatar: '', bio: '來玩的' },
    ],
    personaLinks: [{ id: 'l1', kind: 'sameWorld', a: 'sis', b: 'elder', aToB: '妹妹', bToA: '姊姊' }],
} as unknown as UserProfile;
const che = { id: 'c1', name: '阿澈', primaryPersonaKey: 'sis', knownPersonaKeys: ['sis', 'elder'], impression: '主線的印象', lines: { elder: { impression: '對姊姊的印象' } } } as unknown as CharacterProfile;
const yu = { id: 'c2', name: '小雨', primaryPersonaKey: 'elder', knownPersonaKeys: ['elder'] } as unknown as CharacterProfile;
const wrote = (id: number, ...keys: string[]): Message => ({ id, charId: 't', role: 'user', type: 'text', content: '', timestamp: id, metadata: { theaterWriters: keys.map(key => ({ key: `persona:${key}`, name: key })) } } as Message);

describe('演員認識誰、主看哪條線', () => {
    it('認識的＝在場的卡 ∩ 它有線的卡；其他是不認識的', () => {
        expect(storyActorPresence(che, ['sis', 'elder', 'guest'], [])).toEqual({ known: ['sis', 'elder'], strangers: ['guest'], focalKey: 'sis', extraKeys: ['elder'] });
        expect(storyActorPresence(yu, ['sis', 'guest'], [])).toEqual({ known: [], strangers: ['sis', 'guest'], focalKey: undefined, extraKeys: [] });
        expect(storyActorPresence(che, [], [])).toEqual({ known: [], strangers: [], focalKey: undefined, extraKeys: [] });
    });
    it('主看的線：最近執筆的那張 > 主線 > 第一張；沒記執筆者的舊訊息、繼續那輪跳過', () => {
        expect(focalStoryKey(che, ['sis', 'elder'], [wrote(1, 'sis'), wrote(2, 'elder')])).toBe('elder');
        expect(focalStoryKey(che, ['sis', 'elder'], [wrote(1, 'elder'), { role: 'user', metadata: {} } as any, { role: 'assistant', metadata: {} } as any])).toBe('elder');
        expect(focalStoryKey(che, ['sis', 'elder'], [wrote(1, 'guest')])).toBe('sis');
        expect(focalStoryKey(che, ['elder'], [])).toBe('elder');
        expect(focalStoryKey({ primaryPersonaKey: 'x' }, ['elder', 'sis'], [])).toBe('elder');
        expect(focalStoryKey(che, [], [wrote(1, 'sis')])).toBeUndefined();
    });
    it('照線看到的角色卡：主線就是本人；別條線換成那條線的印象，而且認得出是哪條線', () => {
        expect(storyActorLineView(che, 'sis')).toBe(che);
        expect(storyActorLineView(che, undefined)).toBe(che);
        const view = storyActorLineView(che, 'elder');
        expect(view.impression).toBe('對姊姊的印象');
        expect(lineViewPersonaKey(view)).toBe('elder');
        expect(resolveUserProfileForChar(base, view).name).toBe('姊姊');
        // 帶記憶時把視圖展開成新物件，線的記號要跟著
        expect(lineViewPersonaKey({ ...view, memoryPalaceInjection: 'x' })).toBe('elder');
    });
    it('記憶標籤照主看的線：別條線的記憶標出是跟誰的；只有一條線的角色不標', () => {
        expect(memoryLineLabelsFor(storyActorLineView(che, 'elder'), base)).toMatchObject({ currentKey: 'elder', primaryKey: 'sis', names: { sis: '妹妹', elder: '姊姊' } });
        expect(memoryLineLabelsFor(yu, base)).toBeUndefined();
    });
});

describe('「在場的人你認識誰」那段', () => {
    it('只有一位在場、就是它認識的那位：不加任何東西（跟以前一樣）', () => {
        expect(buildStoryActorPresenceNote({ actorName: '阿澈', focalName: '妹妹', multi: false, extras: [], strangerNames: [], linkLines: [] })).toBe('');
        // 只有面具或你演的角色在場：照舊靠記憶那段的聲明，這裡不加
        expect(buildStoryActorPresenceNote({ actorName: '阿澈', multi: false, extras: [], strangerNames: [], absentKnownName: '妹妹', linkLines: [] })).toBe('');
    });
    it('認識兩位：主看的那位說清楚，另一位補上那條線的印象；不認識的另外說；連結照實說', () => {
        const note = buildStoryActorPresenceNote({
            actorName: '阿澈', focalName: '妹妹', multi: true,
            extras: [{ name: '姊姊', about: '  印象：可靠' }],
            strangerNames: ['表妹'],
            linkLines: storyPresentLinkLines(che, base, ['sis', 'elder', 'guest']),
        });
        expect(note).toBe([
            '### 阿澈：在場的人你認識誰',
            '- 在場的「妹妹」就是你上面角色檔案裡的那個人，關係照舊。',
            '- 你也認識在場的「姊姊」（你們私下另有一段關係；以下是你跟 TA 之間的）。\n  印象：可靠',
            '- 在場的「表妹」你私下不認識：照這場戲和 TA 的資料認人，是另一個人，不要把 TA 當成「妹妹」。',
            '- 在場的「妹妹」是「姊姊」的妹妹，「姊姊」是「妹妹」的姊姊。TA 們是不同的人。',
        ].join('\n'));
    });
    it('一張在場的卡都不認識：說它認識的那位不在場；連結只跟認識其中一位的人說', () => {
        const note = buildStoryActorPresenceNote({ actorName: '小雨', multi: true, extras: [], strangerNames: ['妹妹', '表妹'], absentKnownName: '姊姊', linkLines: storyPresentLinkLines(yu, base, ['sis', 'guest']) });
        expect(note).toContain('在場的「妹妹」「表妹」你私下不認識：照這場戲和 TA 的資料認人。');
        expect(note).toContain('你私下認識的「姊姊」這場戲不在場');
        expect(storyPresentLinkLines(yu, base, ['sis', 'elder'])).toHaveLength(1);
        expect(storyPresentLinkLines({ ...yu, knownPersonaKeys: ['guest'], primaryPersonaKey: 'guest' } as CharacterProfile, base, ['sis', 'elder'])).toEqual([]);
        expect(storyPresentLinkLines(che, base, ['sis'])).toEqual([]);
    });
});

describe('幕後須知', () => {
    it('演員私下認識的不是同一位才列；都同一位、只有一個演員不列', () => {
        const note = buildStoryKnownPeopleNote([che, yu], base);
        expect(note).toContain('阿澈 私下認識的是「妹妹」；小雨 私下認識的是「姊姊」');
        expect(note).toContain('故事裡沒提過的就別裝作知道');
        expect(note).not.toContain('群');
        expect(buildStoryKnownPeopleNote([che], base)).toBe('');
        expect(buildStoryKnownPeopleNote([che, { ...yu, primaryPersonaKey: 'sis' }], base)).toBe('');
    });
});

describe('記憶那段的歸屬聲明', () => {
    const msg = { id: 1, charId: 'c1', role: 'user', type: 'text', content: '晚安', timestamp: 0 } as Message;
    it('不給新參數：跟以前一字不差（同一個人、換了身份兩種）', () => {
        expect(buildStoryActorMemoryEnvelope('阿澈', '記憶', '妹妹', '妹妹', {})).toBe(buildStoryActorMemoryEnvelope('阿澈', '記憶', '妹妹', '妹妹'));
        expect(buildStoryActorMemoryEnvelope('阿澈', '記憶', '妹妹', '妹妹')).toContain('本劇情當前用戶側身份仍是「妹妹」');
        expect(buildStoryActorMemoryEnvelope('阿澈', '記憶', '妹妹', '旅人')).toContain('不得因此把舊記憶裡的“你”從「妹妹」改綁到當前身份');
        expect(formatActorRecentMessages(che, [msg], '妹妹', '妹妹', {})).toBe(formatActorRecentMessages(che, [msg], '妹妹', '妹妹'));
        expect(formatActorRecentMessages(che, [msg], '妹妹', '妹妹')).not.toContain('也在場');
    });
    it('好幾個你同場：說清楚記憶裡的「你」是在場的哪一位', () => {
        expect(buildStoryActorMemoryEnvelope('阿澈', '記憶', '妹妹', '妹妹', { othersPresent: ['妹妹', '姊姊'] }))
            .toContain('「妹妹」這場戲也在場：記憶原文裡的“你”指的就是在場的「妹妹」，不是同場的「姊姊」。');
        expect(formatActorRecentMessages(che, [msg], '妹妹', '妹妹', { othersPresent: ['姊姊'] })).toContain('下列“記憶中的你”就是在場的「妹妹」，不是同場的「姊姊」');
    });
    it('它認識的那位不在場（旁觀、或在場的都不是）：不得改綁到在場的人', () => {
        expect(buildStoryActorMemoryEnvelope('小雨', '記憶', '姊姊', '作者', { absent: true })).toContain('「姊姊」這場戲不在場');
        expect(buildStoryActorMemoryEnvelope('小雨', '記憶', '姊姊', '作者', { absent: true })).not.toContain('當前用戶側執筆身份是「作者」');
        expect(formatActorRecentMessages(yu, [msg], '姊姊', '妹妹、表妹', { absent: true })).toContain('「姊姊」這場戲不在場；下列“記憶中的你”是 TA，不是在場的任何人');
    });
});
