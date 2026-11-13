import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearInputFidelityUnsupported,
    describeFaceLock,
    faceLockOf,
    faceLockReferencePrompt,
    inputFidelityFor,
    isInputFidelityUnsupported,
    markInputFidelityUnsupported,
    strongestFaceLock,
} from './faceLock';
import { generateImage } from './imageGeneration';

const memory = new Map<string, string>();
beforeEach(() => {
    memory.clear();
    vi.stubGlobal('localStorage', {
        getItem: (k: string) => memory.get(k) ?? null,
        setItem: (k: string, v: string) => { memory.set(k, v); },
        removeItem: (k: string) => { memory.delete(k); },
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('鎖臉強度', () => {
    it('沒設就是平衡；合照照最強的', () => {
        expect(faceLockOf(undefined)).toBe('balanced');
        expect(faceLockOf({ faceLock: 'exact' })).toBe('exact');
        expect(strongestFaceLock(['balanced', 'exact'])).toBe('exact');
        expect(strongestFaceLock(['balanced', undefined])).toBe('balanced');
    });

    it('平衡只對長相、畫法照畫風；還原要求高度一致', () => {
        expect(faceLockReferencePrompt('balanced')).toContain('不要照抄參考圖的畫風');
        expect(faceLockReferencePrompt('balanced')).not.toContain('高度一致');
        expect(faceLockReferencePrompt('exact')).toContain('高度一致');
        expect(faceLockReferencePrompt('balanced', 2)).toContain('依序對應');
    });

    it('input_fidelity：只有還原＋GPT-Image＋沒關＋沒被記成不收', () => {
        const api = { baseUrl: 'https://relay/v1', model: 'gpt-image-1' };
        expect(inputFidelityFor('exact', api)).toBe('high');
        expect(inputFidelityFor('balanced', api)).toBeUndefined();
        expect(inputFidelityFor('exact', { ...api, model: 'gemini-2.5-flash-image' })).toBeUndefined();
        expect(inputFidelityFor('exact', { ...api, inputFidelity: 'off' })).toBeUndefined();
        markInputFidelityUnsupported('https://relay/v1/', 'GPT-Image-1');
        expect(isInputFidelityUnsupported('https://relay/v1', 'gpt-image-1')).toBe(true);
        expect(inputFidelityFor('exact', api)).toBeUndefined();
        clearInputFidelityUnsupported('https://relay/v1', 'gpt-image-1');
        expect(inputFidelityFor('exact', api)).toBe('high');
    });

    it('說明那行', () => {
        expect(describeFaceLock('balanced')).toBe('鎖臉：平衡');
        expect(describeFaceLock('exact', true)).toBe('鎖臉：還原（有送強度參數）');
        expect(describeFaceLock('exact', false)).toBe('鎖臉：還原（只用提示詞）');
    });
});

describe('generateImage 送 input_fidelity', () => {
    const config: any = { baseUrl: 'https://relay/v1', apiKey: 'k', model: 'gpt-image-1' };
    const ok = () => new Response(JSON.stringify({ data: [{ b64_json: 'eA==' }] }), { status: 200 });
    const sentFidelity = (call: any) => (call[1].body as FormData).get('input_fidelity');

    it('還原：送 high；平衡：不送，約束換成只對長相', async () => {
        const fetchMock = vi.fn(async (..._args: any[]) => ok());
        vi.stubGlobal('fetch', fetchMock);
        const r = await generateImage(config, '健身', new Blob(['x']), { faceLock: 'exact', hasPerson: true });
        expect(sentFidelity(fetchMock.mock.calls[0])).toBe('high');
        expect(r).toMatchObject({ faceLock: 'exact', fidelitySent: true });
        await generateImage(config, '健身', new Blob(['x']), { char: { imageGenCharConfig: {} } as any, hasPerson: true });
        expect(sentFidelity(fetchMock.mock.calls[1])).toBeNull();
        expect(((fetchMock.mock.calls[1] as any)[1].body as FormData).get('prompt')).toContain('不要照抄參考圖的畫風');
    });

    it('中轉不認（400）：拿掉重送、記成不收，下次不再送', async () => {
        const fetchMock = vi.fn<(...args: any[]) => Promise<Response>>()
            .mockResolvedValueOnce(new Response('unknown parameter: input_fidelity', { status: 400 }))
            .mockImplementation(async () => ok());
        vi.stubGlobal('fetch', fetchMock);
        const r = await generateImage(config, '健身', new Blob(['x']), { faceLock: 'exact', hasPerson: true });
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(sentFidelity(fetchMock.mock.calls[1])).toBeNull();
        expect(r).toMatchObject({ referenceUsed: true, fidelitySent: false });
        expect(isInputFidelityUnsupported('https://relay/v1', 'gpt-image-1')).toBe(true);
        await generateImage(config, '健身', new Blob(['x']), { faceLock: 'exact', hasPerson: true });
        expect(sentFidelity(fetchMock.mock.calls[2])).toBeNull();
    });

    it('額度或權限的錯不當成參數不認', async () => {
        const fetchMock = vi.fn<(...args: any[]) => Promise<Response>>()
            .mockResolvedValueOnce(new Response('quota', { status: 429 }))
            .mockImplementation(async () => ok());
        vi.stubGlobal('fetch', fetchMock);
        await generateImage(config, '健身', new Blob(['x']), { faceLock: 'exact', hasPerson: true });
        // 429 直接退到純文字那條，不重送 edits、不記成不收
        expect(String(fetchMock.mock.calls[1][0])).toContain('/images/generations');
        expect(isInputFidelityUnsupported('https://relay/v1', 'gpt-image-1')).toBe(false);
    });
});
