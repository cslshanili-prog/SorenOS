import { describe, expect, it, vi } from 'vitest';

const generateImage = vi.fn();
const resolveCharacterReferenceImage = vi.fn();
vi.mock('./imageGeneration', () => ({
    generateImage: (...args: any[]) => generateImage(...args),
    resolveCharacterReferenceImage: (...args: any[]) => resolveCharacterReferenceImage(...args),
}));

import {
    buildLibraryImagePrompt,
    defaultLibraryGenAccess,
    describeLibraryGenLock,
    generateLibraryImage,
    libraryGenSubjectError,
} from './libraryGenerate';

const char = (id: string, ref: boolean, appearance?: string): any => ({
    id, name: id, imageGenCharConfig: { characterPrompt: appearance, referenceEnabled: ref, referenceImage: ref ? `blobref:${id}` : undefined },
});
const imageConfig = { baseUrl: 'https://img/v1', model: 'm', apiKey: 'k' } as any;

describe('資料庫 · 在這裡生成', () => {
    it('人數：獨照一個、合照兩個以上', () => {
        expect(libraryGenSubjectError('solo', 0)).toBe('獨照選一個人');
        expect(libraryGenSubjectError('solo', 1)).toBeNull();
        expect(libraryGenSubjectError('group', 1)).toBe('合照至少選兩個人');
        expect(libraryGenSubjectError('group', 3)).toBeNull();
        expect(libraryGenSubjectError('object', 0)).toBeNull();
    });

    it('提示詞：每個人一行，參考圖照順序編號；物品風景寫明沒有人', () => {
        const prompt = buildLibraryImagePrompt({
            kind: 'group', prompt: '海邊並肩坐著',
            people: [{ appearance: '黑髮', hasRef: true }, { appearance: '短髮', gender: '女', hasRef: false }, { hasRef: true }],
        });
        expect(prompt).toContain('畫面裡有 3 個人');
        expect(prompt).toContain('人物一：黑髮；長相照第 1 張參考圖');
        expect(prompt).toContain('人物二：女性；短髮');
        expect(prompt).toContain('人物三：長相照第 2 張參考圖');
        expect(prompt).toContain('沒寫參考圖的人別套用');
        expect(buildLibraryImagePrompt({ kind: 'scenery', prompt: '雨後夜景' })).toContain('畫面裡沒有人');
        expect(buildLibraryImagePrompt({ kind: 'object', prompt: '一杯拿鐵' })).toContain('物品照');
    });

    it('預設分配：有角色給那幾個角色，物品風景共用', () => {
        const subjects: any[] = [{ type: 'char', char: char('a', true) }, { type: 'user', profile: { name: '你' } }];
        expect(defaultLibraryGenAccess('group', subjects)).toEqual({ mode: 'chars', charIds: ['a'] });
        expect(defaultLibraryGenAccess('object', subjects)).toEqual({ mode: 'all' });
        expect(defaultLibraryGenAccess('solo', [{ type: 'user', profile: { name: '你' } } as any])).toEqual({ mode: 'all' });
    });

    it('身份卡各自一個 key；AI 寫提示詞的說明不寫長相、畫風', async () => {
        const { subjectKey, buildLibraryPromptWriterPrompt } = await import('./libraryGenerate');
        expect(subjectKey({ type: 'user', profile: { name: '你' } as any })).toBe('user');
        expect(subjectKey({ type: 'user', profile: { name: '妹妹' } as any, personaKey: 'pB' })).toBe('user:pB');
        const p = buildLibraryPromptWriterPrompt({ kind: 'group', text: '海邊 黃昏', names: ['阿澈', '你'] });
        expect(p).toContain('關鍵字：海邊 黃昏');
        expect(p).toContain('畫面裡的人：阿澈、你');
        expect(p).toContain('不要寫人物的長相');
        expect(buildLibraryPromptWriterPrompt({ kind: 'scenery', text: '雨夜', names: [] })).toContain('畫面裡沒有人');
    });

    it('鎖臉說明', () => {
        expect(describeLibraryGenLock(0, 0)).toBe('沒鎖臉（沒有參考圖）');
        expect(describeLibraryGenLock(1, 1)).toBe('鎖了臉');
        expect(describeLibraryGenLock(2, 2)).toBe('2 張臉都鎖了');
        expect(describeLibraryGenLock(1, 3)).toBe('只鎖了 1 張臉（生圖服務不收多張參考圖）');
        expect(describeLibraryGenLock(1, 1, undefined, 2)).toBe('鎖了 1 張臉（另外 1 個人沒參考圖）');
    });

    it('合照：有參考圖的照順序送，算出實際鎖了幾張', async () => {
        const blobA = new Blob(['a']);
        const blobUser = new Blob(['u']);
        resolveCharacterReferenceImage.mockImplementation(async (who: any) => (who.imageGenCharConfig?.referenceImage === 'blobref:a' ? blobA : who.imageGenCharConfig?.referenceImage === 'blobref:me' ? blobUser : null));
        generateImage.mockResolvedValue({ dataUrl: 'data:image/png;base64,x', referenceUsed: true, referenceCount: 1, referenceError: 'HTTP 400' });
        const result = await generateLibraryImage({
            kind: 'group', prompt: '海邊', imageConfig,
            subjects: [
                { type: 'char', char: char('a', true) },
                { type: 'char', char: char('b', false) },
                { type: 'user', profile: { name: '你', imageGenConfig: { referenceEnabled: true, referenceImage: 'blobref:me' } } as any },
            ],
        });
        expect(generateImage.mock.calls[0][2]).toEqual([blobA, blobUser]);
        expect(result).toMatchObject({ wantedLocks: 2, lockedCount: 1, lockError: 'HTTP 400' });
        await expect(generateLibraryImage({ kind: 'solo', prompt: 'x', imageConfig, subjects: [] })).rejects.toThrow('獨照選一個人');
        await expect(generateLibraryImage({ kind: 'object', prompt: ' ', imageConfig, subjects: [] })).rejects.toThrow('先寫想拍什麼');
    });

    it('物品：不帶參考圖', async () => {
        generateImage.mockClear();
        generateImage.mockResolvedValue({ dataUrl: 'data:x' });
        const result = await generateLibraryImage({ kind: 'object', prompt: '拿鐵', imageConfig, subjects: [{ type: 'char', char: char('a', true) }] });
        expect(generateImage.mock.calls[0][2]).toBeUndefined();
        expect(result.wantedLocks).toBe(0);
    });
});
