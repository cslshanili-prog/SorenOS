import { describe, expect, it, vi } from 'vitest';
import { buildMomentImagePrompt, buildMomentSceneMessages, canCaptureDateMoment, captureDateMoment, describeMomentLock } from './dateMoment';
import { generateImage } from './imageGeneration';
import { resolveUserProfileForChar } from './userPersona';
import type { CharacterProfile, Message, UserProfile } from '../types';

describe('拍下這一刻：提示詞', () => {
    it('畫面描述的提示詞：兩個人、不寫名字、帶大綱和故事時間', () => {
        const [sys, user] = buildMomentSceneMessages({ charName: '凱恩', userName: '小雨', scenario: '雨夜書店', timeText: '1920-03-01 20:00 週一',
            messages: [{ id: 1, role: 'assistant', type: 'text', content: '他把傘收起來。\n[soft] 「你來了。」', timestamp: 1 } as Message] });
        expect(sys.content).toContain('人物一是凱恩');
        expect(sys.content).toContain('雨夜書店');
        expect(sys.content).toContain('1920-03-01');
        expect(sys.content).toContain('不要寫名字');
        expect(user.content).toContain('「你來了。」');
        expect(user.content).not.toContain('[soft]');
    });

    it('生圖提示詞：誰對哪張參考圖寫清楚，只有一張時另一個人別套', () => {
        const both = buildMomentImagePrompt({ scene: '書店裡。', charAppearance: '黑髮', userAppearance: '短髮', userGender: '女', refs: { char: true, user: true } });
        expect(both).toContain('人物一：黑髮；長相照第 1 張參考圖');
        expect(both).toContain('人物二：女性；短髮；長相照第 2 張參考圖');
        const onlyUser = buildMomentImagePrompt({ scene: '書店裡。', refs: { char: false, user: true } });
        expect(onlyUser).toContain('人物二：長相照第 1 張參考圖');
        expect(onlyUser).toContain('只有人物二有參考圖');
        expect(buildMomentImagePrompt({ scene: 'x' })).toContain('人物一：照劇情自然發揮');
    });

    it('要開角色生圖、填好 API 才能拍', () => {
        expect(canCaptureDateMoment(undefined)).toBe(false);
        expect(canCaptureDateMoment({ charImageGenEnabled: true, baseUrl: 'https://x', model: 'm' } as any)).toBe(true);
        expect(canCaptureDateMoment({ baseUrl: 'https://x', model: 'm' } as any)).toBe(false);
        expect(describeMomentLock('char', '不支援')).toContain('不收兩張');
    });
});

describe('多張參考圖', () => {
    const cfg = { baseUrl: 'https://img.test/v1', apiKey: 'k', model: 'gpt-image-1' };
    const ok = () => new Response(JSON.stringify({ data: [{ b64_json: 'QUJD' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    it('兩張一起用 image[] 送；不收就只送第一張；再不行純文字', async () => {
        const calls: { url: string; images: number; field?: string }[] = [];
        const real = globalThis.fetch;
        let failMulti = false, failSingle = false;
        globalThis.fetch = vi.fn(async (url: any, init: any) => {
            const body = init?.body;
            if (body instanceof FormData) {
                const multi = body.getAll('image[]').length, single = body.getAll('image').length;
                calls.push({ url: String(url), images: multi || single, field: multi ? 'image[]' : 'image' });
                if ((multi && failMulti) || (single && failSingle)) return new Response('no', { status: 400 });
                return ok();
            }
            calls.push({ url: String(url), images: 0 });
            return ok();
        }) as any;
        try {
            const a = new Blob(['a']), b = new Blob(['b']);
            const r1 = await generateImage(cfg, 'p', [a, b]);
            expect(r1).toMatchObject({ referenceUsed: true, referenceCount: 2 });
            expect(calls.pop()).toMatchObject({ images: 2, field: 'image[]' });

            failMulti = true; calls.length = 0;
            const r2 = await generateImage(cfg, 'p', [a, b]);
            expect(r2).toMatchObject({ referenceUsed: true, referenceCount: 1 });
            expect(r2.referenceError).toContain('多張參考圖不支援');
            expect(calls.map(c => c.field)).toEqual(['image[]', 'image']);

            failSingle = true; calls.length = 0;
            const r3 = await generateImage(cfg, 'p', [a, b]);
            expect(r3.referenceUsed).toBe(false);
            expect(calls.map(c => c.url.endsWith('/images/generations'))).toEqual([false, false, true]);

            // 一張的時候照舊用 image
            failSingle = false; calls.length = 0;
            await generateImage(cfg, 'p', a);
            expect(calls[0]).toMatchObject({ field: 'image', images: 1 });
        } finally {
            globalThis.fetch = real;
        }
    });
});

describe('身份卡的長相跟著卡走', () => {
    it('這個角色用的身份卡有自己的長相；沒設就是沒有，不拿真實身份那張臉', () => {
        const base = {
            name: '真', avatar: '', bio: '', imageGenConfig: { referenceEnabled: true, referenceImage: 'blobref:real', characterPrompt: '本人' },
            personas: [{ id: 'p1', name: '卡一', avatar: '', bio: '', createdAt: 1, updatedAt: 1, imageGenConfig: { characterPrompt: '卡一長相' } }, { id: 'p2', name: '卡二', avatar: '', bio: '', createdAt: 1, updatedAt: 1 }],
            perCharPersonaIds: { a: 'p1', b: 'p2' },
        } as unknown as UserProfile;
        expect(resolveUserProfileForChar(base, { id: 'a' } as CharacterProfile).imageGenConfig?.characterPrompt).toBe('卡一長相');
        expect(resolveUserProfileForChar(base, { id: 'b' } as CharacterProfile).imageGenConfig).toBeUndefined();
        expect(resolveUserProfileForChar(base, { id: 'c' } as CharacterProfile).imageGenConfig?.characterPrompt).toBe('本人');
    });
});

describe('captureDateMoment', () => {
    it('沒有劇情就不拍', async () => {
        await expect(captureDateMoment({ char: { id: 'c', name: '凱恩' } as CharacterProfile, user: { name: '小雨' } as UserProfile, story: null, messages: [],
            chatApi: { baseUrl: 'x', apiKey: 'k', model: 'm' }, imageConfig: { baseUrl: 'x', model: 'm' } as any })).rejects.toThrow('還沒有劇情');
    });
});
