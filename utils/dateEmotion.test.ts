import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CharacterBuff, CharacterProfile, DateStory } from '../types';

const stories = new Map<string, DateStory>();
vi.mock('./dateStory', () => ({
    patchDateStory: vi.fn(async (id: string, patch: (prev: DateStory) => Partial<DateStory>) => {
        const prev = stories.get(id)!;
        const next = { ...prev, ...patch(prev) };
        stories.set(id, next);
        return next;
    }),
}));

const { applyDateEmotionRaw, dateEmotionState, patchDateEmotion, shouldEvaluateDateEmotion, splitForEmotionEval, withStoryEmotion } = await import('./dateEmotion');

const buff = (id: string, patch: Partial<CharacterBuff> = {}): CharacterBuff => ({ id, name: id, label: id, intensity: 2, since: Date.now(), ...patch });
const char = (patch: Partial<CharacterProfile> = {}): CharacterProfile => ({
    id: 'c1', name: '凱恩', activeBuffs: [buff('私聊的想念')], buffInjection: '私聊的底色', buffInjectionAt: 5, ...patch,
} as CharacterProfile);
const story = (patch: Partial<DateStory> = {}): DateStory => ({ id: 's1', charId: 'c1', status: 'ongoing', createdAt: 1, updatedAt: 1, ...patch });

beforeEach(() => stories.clear());

describe('線下情緒獨立', () => {
    it('關著：照私聊那份，角色原樣', () => {
        const c = char();
        expect(dateEmotionState(c, story({ emotion: { activeBuffs: [], buffInjection: '見面的' } }))).toBeNull();
        expect(withStoryEmotion(c, story())).toBe(c);
    });

    it('開著：故事有自己那份就用；還沒有就從私聊此刻那份接；沒有故事照私聊', () => {
        const c = char({ dateEmotionIndependent: true });
        const own = { activeBuffs: [buff('雨夜的心動')], buffInjection: '見面的底色', buffInjectionAt: 9 };
        expect(withStoryEmotion(c, story({ emotion: own }))).toMatchObject(own);
        expect(withStoryEmotion(c, story()).buffInjection).toBe('私聊的底色');
        expect(withStoryEmotion(c, null)).toBe(c);
    });

    it('評估的閘：要開獨立，而且情緒系統開著', () => {
        expect(shouldEvaluateDateEmotion(char({ dateEmotionIndependent: true, emotionConfig: { enabled: true } as any, scheduleFeatureEnabled: true }))).toBe(true);
        expect(shouldEvaluateDateEmotion(char({ dateEmotionIndependent: true, emotionConfig: { enabled: true } as any, scheduleFeatureEnabled: false }))).toBe(false);
        expect(shouldEvaluateDateEmotion(char({ emotionConfig: { enabled: true } as any, scheduleFeatureEnabled: true }))).toBe(false);
    });

    it('拆 messages：開頭的 system 是系統提示，其餘接上這則回覆；預填拿掉', () => {
        const { systemPrompt, history } = splitForEmotionEval([
            { role: 'system', content: '角色設定' },
            { role: 'system', content: '見面框架' },
            { role: 'user', content: '「嗨」' },
            { role: 'system', content: '每輪提醒' },
            { role: 'assistant', content: '<think>' },
        ], '「來了？」');
        expect(systemPrompt).toBe('角色設定\n\n見面框架');
        expect(history).toEqual([{ role: 'user', content: '「嗨」' }, { role: 'system', content: '每輪提醒' }, { role: 'assistant', content: '「來了？」' }]);
    });

    it('評估結果只寫進故事：第一次以私聊那份為底，之後接著自己那份', async () => {
        const c = char({ dateEmotionIndependent: true });
        stories.set('s1', story());
        await applyDateEmotionRaw(JSON.stringify({ changed: true, buffs: [{ id: 'b1', name: 'flutter', label: '心動', intensity: 3 }], injection: '見面的底色' }), c, 's1');
        const first = stories.get('s1')!.emotion!;
        expect(first.activeBuffs.map(b => b.label)).toEqual(['心動']);
        expect(first.buffInjection).toBe('見面的底色');
        // 只給 injection（buffs 缺）→ 保留故事自己的 buffs，不是私聊的
        await applyDateEmotionRaw(JSON.stringify({ changed: true, injection: '更新的底色' }), c, 's1');
        expect(stories.get('s1')!.emotion!.activeBuffs.map(b => b.label)).toEqual(['心動']);
        expect(stories.get('s1')!.emotion!.buffInjection).toBe('更新的底色');
        // 沒變化不動
        await applyDateEmotionRaw(JSON.stringify({ changed: false }), c, 's1');
        expect(stories.get('s1')!.emotion!.buffInjection).toBe('更新的底色');
        // 角色本身沒被改
        expect(c.buffInjection).toBe('私聊的底色');
    });

    it('面板改動寫進故事；還沒有自己那份就先從私聊接再改', async () => {
        stories.set('s1', story());
        await patchDateEmotion(char({ dateEmotionIndependent: true }), 's1', { buffInjection: '' });
        expect(stories.get('s1')!.emotion).toMatchObject({ buffInjection: '', activeBuffs: [expect.objectContaining({ label: '私聊的想念' })] });
    });
});
