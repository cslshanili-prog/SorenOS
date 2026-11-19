import { describe, expect, it } from 'vitest';
import type { CharacterProfile, Message, UserProfile } from '../types';
import { buildStoryActorBlock, type StoryActorBlockInput } from './storyActorContext';
import { formatActorRecentMessages } from './storyTheater';
import { lineViewPersonaKey } from './userPersona';

// 劇情裡一個演員的檔案塊（plans/story-multi-persona.md 第 2 批）：照哪條線、放哪幾段、聲明寫什麼

const base = {
    name: 'Liora', avatar: '', bio: '',
    personas: [
        { id: 'sis', name: '妹妹', avatar: '', bio: '' },
        { id: 'elder', name: '姊姊', avatar: '', bio: '' },
        { id: 'guest', name: '表妹', avatar: '', bio: '' },
    ],
    personaLinks: [{ id: 'l1', kind: 'sameWorld', a: 'sis', b: 'elder' }],
} as unknown as UserProfile;
const che = { id: 'c1', name: '阿澈', primaryPersonaKey: 'sis', knownPersonaKeys: ['sis', 'elder'], lines: { elder: { impression: '對姊姊的印象' } } } as unknown as CharacterProfile;
const yu = { id: 'c2', name: '小雨', primaryPersonaKey: 'elder', knownPersonaKeys: ['elder'] } as unknown as CharacterProfile;
const said = (content: string): Message => ({ id: 1, charId: 'x', role: 'user', type: 'text', content, timestamp: 0 } as Message);
const wrote = (key: string) => ({ role: 'user', metadata: { theaterWriters: [{ key: `persona:${key}`, name: key }] } }) as any;

const run = async (over: Partial<StoryActorBlockInput>) => {
    const calls = { recent: [] as string[], recall: [] as string[], core: [] as string[] };
    const lineOf = (view: CharacterProfile) => lineViewPersonaKey(view) || 'primary';
    const text = await buildStoryActorBlock({
        actor: che, profileBase: base, presentPersonaKeys: ['sis'], identityNames: ['妹妹'], identityLabel: '妹妹', lurking: false, storyMsgs: [],
        loadRecent: async view => { calls.recent.push(lineOf(view)); return [said(`在 ${lineOf(view)} 線說的話`)]; },
        recall: async (view, _recent, userName) => { calls.recall.push(`${lineOf(view)}:${userName}`); return '一段記憶'; },
        buildCore: (view, profile, recalled) => { calls.core.push(`${lineOf(view)}:${profile.name}`); return `[核心:${profile.name}]${recalled ? `\n${recalled}` : ''}`; },
        lineSections: view => ({ impression: `印象：${(view as any).impression || '無'}\n`, memoryBank: '暫無特定記憶' }),
        ...over,
    });
    return { text, calls };
};

describe('一個演員的檔案塊', () => {
    it('只有一位在場、是它認識的：只有核心和那條線的最近聊天，沒有多的段落', async () => {
        const { text, calls } = await run({});
        expect(calls).toEqual({ recent: ['primary'], recall: ['primary:妹妹'], core: ['primary:妹妹'] });
        expect(text.startsWith('[核心:妹妹]\n### 阿澈 的專屬既有記憶')).toBe(true);
        expect(text).toContain('本劇情當前用戶側身份仍是「妹妹」');
        expect(text.endsWith(formatActorRecentMessages(che, [said('在 primary 線說的話')], '妹妹', '妹妹'))).toBe(true);
        expect(text).not.toContain('在場的人你認識誰');
    });
    it('認識兩位都在場：主看主線，另一條線補印象和最近聊天，記憶只召回一次', async () => {
        const { text, calls } = await run({ presentPersonaKeys: ['sis', 'elder', 'guest'], identityNames: ['妹妹', '姊姊', '表妹'], identityLabel: '妹妹、姊姊、表妹' });
        expect(calls).toEqual({ recent: ['primary', 'elder'], recall: ['primary:妹妹'], core: ['primary:妹妹'] });
        expect(text).toContain('「妹妹」這場戲也在場：記憶原文裡的“你”指的就是在場的「妹妹」，不是同場的「姊姊」「表妹」。');
        expect(text).toContain('以下記錄只屬於「阿澈」與原互動對象「妹妹」');
        expect(text).toContain('以下記錄只屬於「阿澈」與原互動對象「姊姊」');
        expect(text).toContain('在 elder 線說的話');
        expect(text).toContain('- 你也認識在場的「姊姊」（你們私下另有一段關係；以下是你跟 TA 之間的）。\n  印象：對姊姊的印象');
        expect(text).toContain('- 在場的「表妹」你私下不認識');
        expect(text).toContain('- 在場的「妹妹」跟「姊姊」互相認識。TA 們是不同的人。');
    });
    it('最近執筆的是姊姊：主看的線換成姊姊那條，主線變成補充的那段', async () => {
        const { text, calls } = await run({ presentPersonaKeys: ['sis', 'elder'], identityNames: ['妹妹', '姊姊'], identityLabel: '妹妹、姊姊', storyMsgs: [wrote('sis'), wrote('elder')] });
        expect(calls).toEqual({ recent: ['elder', 'primary'], recall: ['elder:姊姊'], core: ['elder:姊姊'] });
        expect(text).toContain('- 在場的「姊姊」就是你上面角色檔案裡的那個人，關係照舊。');
        expect(text).toContain('- 你也認識在場的「妹妹」');
    });
    it('在場的卡它一張都不認識：檔案照它自己的主線，並說清楚它認識的那位不在場', async () => {
        const { text, calls } = await run({ actor: yu, presentPersonaKeys: ['sis', 'guest'], identityNames: ['妹妹', '表妹'], identityLabel: '妹妹、表妹' });
        expect(calls).toEqual({ recent: ['primary'], recall: ['primary:姊姊'], core: ['primary:姊姊'] });
        expect(text).toContain('「姊姊」這場戲不在場：記憶原文裡的“你”指的是 TA');
        expect(text).toContain('「姊姊」這場戲不在場；下列“記憶中的你”是 TA，不是在場的任何人');
        expect(text).toContain('- 在場的「妹妹」「表妹」你私下不認識：照這場戲和 TA 的資料認人。');
        expect(text).toContain('- 你私下認識的「姊姊」這場戲不在場');
    });
    it('旁觀：它認識的那位不在場，不會寫成「當前身份是作者」', async () => {
        const { text } = await run({ presentPersonaKeys: [], identityNames: [], identityLabel: '作者', lurking: true });
        expect(text).toContain('「妹妹」這場戲不在場');
        expect(text).not.toContain('「作者」');
        expect(text).not.toContain('在場的人你認識誰');
    });
    it('只有面具或你演的角色在場：照舊（當前身份另有其人，不得改綁），不多加段落', async () => {
        const { text } = await run({ presentPersonaKeys: [], identityNames: ['旅人'], identityLabel: '旅人' });
        expect(text).toContain('本劇情當前用戶側執筆身份是「旅人」，不得因此把舊記憶裡的“你”從「妹妹」改綁到當前身份。');
        expect(text).toContain('當前執筆身份是「旅人」；不得把下列“記憶中的你”重新解釋成當前身份。');
        expect(text).not.toContain('在場的人你認識誰');
    });
    it('沒有記憶宮殿、那條線也沒聊過：只剩核心', async () => {
        const { text } = await run({ recall: async () => '', loadRecent: async () => [] });
        expect(text).toBe('[核心:妹妹]');
    });
});
