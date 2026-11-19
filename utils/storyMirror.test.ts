import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { isSecondaryStoryMirror, mirrorIdsOf, mirrorKeyCharId, mirrorSceneNote, mirrorWithKeys, mirrorWriterLabel, storyMirrorMetadata, storyMirrorTargets } from './storyMirror';
import { groupMessagesByLine } from './memoryPalace/pipeline';
import { memoryLineLabel } from './memoryPalace/lineLabels';
import { formatMessageForPrompt } from './messageFormat';
import { buildPersonaKnowledge } from './momentsPersona';
import { normalizeStoryTheater, createStoryTheaterDraft } from './storyTheater';
import { storyPresentPersonaKeys } from './storyPresence';

// 劇情的鏡像訊息落哪幾條線、記憶怎麼抽（plans/story-multi-persona.md 第 3 批）

const base = {
    name: 'Liora', avatar: '', bio: '', activePersonaId: 'sis',
    personas: [
        { id: 'sis', name: '妹妹', avatar: '', bio: '' },
        { id: 'elder', name: '姊姊', avatar: '', bio: '' },
        { id: 'guest', name: '表妹', avatar: '', bio: '' },
    ],
} as unknown as UserProfile;
const che = { id: 'c1', name: '阿澈', primaryPersonaKey: 'sis', knownPersonaKeys: ['sis', 'elder'] } as CharacterProfile;
const yu = { id: 'c2', name: '小雨', primaryPersonaKey: 'elder', knownPersonaKeys: ['elder'] } as CharacterProfile;
const targets = (over: Partial<Parameters<typeof storyMirrorTargets>[0]>) =>
    storyMirrorTargets({ actor: che, profileBase: base, presentPersonaKeys: ['sis'], storyMsgs: [], role: 'user', writerKeys: ['sis'], ...over });
const mirror = (id: number, metadata: Record<string, unknown> = {}, personaKey?: string): Message =>
    ({ id, charId: 'c1', role: 'user', type: 'text', content: `第 ${id} 段`, timestamp: id, ...(personaKey ? { personaKey } : {}), metadata: { source: 'story_theater_memory', ...metadata } } as Message);

describe('鏡像落哪幾條線', () => {
    it('只有一個你、是它認識的：一份寫主線，什麼都不多（跟以前一樣）', () => {
        const [only, ...rest] = targets({});
        expect(rest).toEqual([]);
        expect(only).toEqual({ key: 'c1', charId: 'c1', secondary: false, withKeys: [], sceneNote: '' });
        expect(storyMirrorMetadata(only)).toEqual({});
    });
    it('認識兩位都在場：兩條線各一份，主看的那份是主要的，互相記同場的人', () => {
        const list = targets({ presentPersonaKeys: ['sis', 'elder', 'guest'], writerKeys: ['elder'] });
        expect(list.map(t => [t.key, t.personaKey, t.secondary, t.withKeys])).toEqual([
            ['c1', undefined, true, ['elder']],
            ['c1::elder', 'elder', false, ['sis']],
        ]);
        // 妹妹那條線：這段是姊姊寫的，要標出來
        expect(list[0].writerLabel).toBe('姊姊');
        expect(list[0].sceneNote).toBe('同場還有你也認識的「姊姊」；同場還有「表妹」（你私下不認識）；這段由「姊姊」執筆');
        // 姊姊那條線：她自己寫的，不用標
        expect(list[1].writerLabel).toBeUndefined();
        expect(list[1].sceneNote).toBe('同場還有你也認識的「妹妹」；同場還有「表妹」（你私下不認識）');
        expect(storyMirrorMetadata(list[0])).toEqual({ theaterMirrorSecondary: true, theaterWithKeys: ['elder'], theaterSceneNote: list[0].sceneNote, theaterWriterLabel: '姊姊' });
    });
    it('模型寫的那段：主看的線照最近執筆的人；沒有執筆者標籤', () => {
        const history = [{ role: 'user', metadata: { theaterWriters: [{ key: 'persona:elder', name: '姊姊' }] } }] as any;
        const list = targets({ presentPersonaKeys: ['sis', 'elder'], role: 'assistant', writerKeys: [], storyMsgs: history });
        expect(list.map(t => [t.key, t.secondary])).toEqual([['c1', true], ['c1::elder', false]]);
        expect(list.every(t => t.writerLabel === undefined)).toBe(true);
        expect(targets({ presentPersonaKeys: ['sis', 'elder'], role: 'assistant', writerKeys: [] }).map(t => t.secondary)).toEqual([false, true]);
    });
    it('姊姊先回家之後的段落，不會出現在姊姊那條線', () => {
        expect(targets({ presentPersonaKeys: ['sis'] }).map(t => t.key)).toEqual(['c1']);
    });
    it('在場的卡它一張都不認識：只寫主線，標清楚它認識的那位不在場、這段是誰寫的', () => {
        const [only, ...rest] = targets({ actor: yu, presentPersonaKeys: ['sis', 'guest'], writerKeys: ['sis'] });
        expect(rest).toEqual([]);
        expect(only).toMatchObject({ key: 'c2', secondary: false, withKeys: [], writerLabel: '妹妹' });
        expect(only.sceneNote).toBe('在場的是「妹妹」「表妹」，都不是你私下認識的「姊姊」');
    });
    it('旁觀：只寫主線，標用戶不在場；你寫的那段是作者寫的', () => {
        const [only] = targets({ presentPersonaKeys: [], writerKeys: [] });
        expect(only).toMatchObject({ key: 'c1', sceneNote: '用戶不在場，是角色們自己的戲', writerLabel: '作者' });
        expect(targets({ presentPersonaKeys: [], writerKeys: [], role: 'assistant' })[0].writerLabel).toBeUndefined();
    });
});

describe('鏡像上記的東西', () => {
    it('讀得回來；不是劇情鏡像的訊息一律當沒有', () => {
        const m = mirror(1, { theaterMirrorSecondary: true, theaterWithKeys: ['elder', 3, ''], theaterSceneNote: '同場還有「姊姊」', theaterWriterLabel: '姊姊' });
        expect([isSecondaryStoryMirror(m), mirrorWithKeys(m), mirrorSceneNote(m), mirrorWriterLabel(m)]).toEqual([true, ['elder'], '同場還有「姊姊」', '姊姊']);
        const chat = { metadata: { theaterMirrorSecondary: true, theaterWithKeys: ['elder'], theaterSceneNote: 'x' } } as any;
        expect([isSecondaryStoryMirror(chat), mirrorWithKeys(chat), mirrorSceneNote(chat)]).toEqual([false, [], '']);
    });
    it('鏡像 id 以線為鍵：取得回全部 id，也認得出是哪個角色', () => {
        expect(mirrorIdsOf({ metadata: { theaterMirrorIds: { c1: 5, 'c1::elder': 6, c2: 0, bad: 'x' } } } as any)).toEqual([5, 6]);
        expect(mirrorKeyCharId('c1::elder')).toBe('c1');
        expect(mirrorKeyCharId('c1')).toBe('c1');
    });
    it('提取記憶時：帶上同場的說明，你寫的那段標真正執筆的人；一般訊息不變', () => {
        expect(formatMessageForPrompt(mirror(1, { theaterSceneNote: '同場還有你也認識的「姊姊」', theaterWriterLabel: '姊姊' }), '阿澈', '妹妹'))
            .toBe('[姊姊]: 〔線下劇情：同場還有你也認識的「姊姊」〕第 1 段');
        expect(formatMessageForPrompt(mirror(1), '阿澈', '妹妹')).toBe('[妹妹]: 第 1 段');
    });
});

describe('記憶宮殿：只抽一次、標同場的人', () => {
    it('好幾個你同場的段落另成一組，組上帶著同場的人；一般私聊、只有一個你的劇情照舊同一組', () => {
        const groups = groupMessagesByLine([
            mirror(1), { ...mirror(2), metadata: {} } as Message, mirror(3, { theaterWithKeys: ['elder'] }), mirror(4, { theaterWithKeys: ['elder'] }),
            mirror(5, {}, 'elder'), mirror(6, { theaterWithKeys: ['sis'] }, 'elder'),
        ]);
        expect(groups.map(g => [g.personaKey, g.withPersonaKeys, g.messages.map(m => m.id)])).toEqual([
            [undefined, undefined, [1, 2]],
            [undefined, ['elder'], [3, 4]],
            ['elder', undefined, [5]],
            ['elder', ['sis'], [6]],
        ]);
    });
    it('召回標籤：一起經歷的事不說「TA 不一定知道」', () => {
        const labels = (currentKey: string) => ({ currentKey, primaryKey: 'sis', names: { sis: '妹妹', elder: '姊姊', guest: '表妹' } });
        // 記在妹妹線、姊姊也在場
        const node = { withPersonaKeys: ['elder'] };
        expect(memoryLineLabel(node, labels('sis'))).toBe('〔那次「姊姊」也在場〕');
        expect(memoryLineLabel(node, labels('elder'))).toBe('〔這是你跟「妹妹」「姊姊」一起的事〕');
        expect(memoryLineLabel(node, labels('guest'))).toBe('〔這是你跟「妹妹」之間的事，「表妹」不一定知道〕');
        // 沒有同場的人：跟以前一樣
        expect(memoryLineLabel({}, labels('sis'))).toBe('');
        expect(memoryLineLabel({}, labels('elder'))).toBe('〔這是你跟「妹妹」之間的事，「姊姊」不一定知道〕');
        expect(memoryLineLabel(node, undefined)).toBe('');
    });
});

describe('寫進角色記憶的劇情：只能是身份卡', () => {
    it('好幾張身份卡留著，面具和你演的角色濾掉；旁觀可以；沒設過照舊是本人', () => {
        const draft = { ...createStoryTheaterDraft(1), writesToCharacterMemory: true };
        const multi = normalizeStoryTheater({ ...draft, presence: [{ type: 'persona', key: 'sis' }, { type: 'custom', id: 'm1' }, { type: 'persona', key: 'elder' }, { type: 'character', id: 'c1' }] });
        expect(multi.presence).toEqual([{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }]);
        expect(multi.mask).toEqual({ type: 'persona', key: 'sis' });
        expect(normalizeStoryTheater({ ...draft, presence: [] })).toMatchObject({ presence: [], mask: { type: 'user' } });
        const legacy = normalizeStoryTheater({ ...draft, mask: { type: 'custom', id: 'm1' } });
        expect(legacy.presence).toBeUndefined();
        expect(legacy.mask).toEqual({ type: 'user' });
    });
});

describe('朋友圈「見過的身份」算上劇情', () => {
    it('劇情裡在場的身份卡，演員都算見過（主身份那張不重複算）；面具、旁觀不算', () => {
        expect(storyPresentPersonaKeys({ presence: [{ type: 'user' }, { type: 'persona', key: 'elder' }, { type: 'custom', id: 'm' }, { type: 'persona', key: 'gone' }] }, base)).toEqual(['sis', 'elder']);
        const chars = [{ id: 'c1', primaryPersonaKey: 'sis' }, { id: 'c2', primaryPersonaKey: 'elder' }, { id: 'c3', primaryPersonaKey: 'guest' }] as any;
        const profile = { ...base, perCharacterPersonaIds: { c1: 'sis', c2: 'elder', c3: 'guest' } } as UserProfile;
        const knowledge = buildPersonaKnowledge(profile, chars, [], [], [
            { id: 's1', characterIds: ['c1', 'c2'], presence: [{ type: 'persona', key: 'sis' }, { type: 'persona', key: 'elder' }] },
            { id: 's2', characterIds: ['c3'], presence: [] },
        ]);
        expect([...knowledge.seenKeysOf('c1')]).toEqual(['elder']);
        expect([...knowledge.seenKeysOf('c2')]).toEqual(['sis']);
        expect([...knowledge.seenKeysOf('c3')]).toEqual([]);
    });
});
