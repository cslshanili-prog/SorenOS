import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./activeMsgStore', () => ({
    ActiveMsgStore: { getGlobalConfig: vi.fn(async () => ({ workerUrl: 'https://w.example/', serverToken: 'tok' })) },
}));

import { parseLlmTranslation, providerLangCode, translateTexts, translationReadiness } from './translateApi';
import type { APIConfig } from '../types';

const base = { baseUrl: 'https://llm.example/v1', apiKey: 'sk-mainkey-0123456789abcdef', model: 'main-model' } as APIConfig;
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

describe('語言代碼', () => {
    it('各家照表，查不到回 null（自訂語言、粵語在 DeepL／Google）', () => {
        expect(providerLangCode('deepl', '繁體中文')).toBe('ZH-HANT');
        expect(providerLangCode('google', '简体中文')).toBe('zh-CN');
        expect(providerLangCode('azure', '粵語')).toBe('yue');
        expect(providerLangCode('deepl', '粵語')).toBeNull();
        expect(providerLangCode('google', 'Español')).toBeNull();
        expect(providerLangCode('llm', 'Español')).toBe('Español');
    });
});

describe('parseLlmTranslation', () => {
    it('挖出 JSON 陣列（包在 ``` 裡也行）', () => {
        expect(parseLlmTranslation('```json\n["你好","再見"]\n```', 2)).toEqual(['你好', '再見']);
    });
    it('只翻一句時接受直接回譯文', () => {
        expect(parseLlmTranslation('你還好嗎？', 1)).toEqual(['你還好嗎？']);
    });
    it('句數不對就丟錯', () => {
        expect(() => parseLlmTranslation('["只有一句"]', 2)).toThrow('格式不對');
    });
});

describe('translationReadiness', () => {
    it('沒設翻譯 API：用主 API 的聊天模型', () => {
        expect(translationReadiness(base)).toEqual({ provider: 'llm', ready: true });
    });
    it('選了 Azure 但缺區域', () => {
        expect(translationReadiness({ ...base, translationApi: { provider: 'azure', azureKey: 'k' } }).ready).toBe(false);
    });
});

describe('translateTexts', () => {
    it('沒設翻譯 API 就用主 API 打 /chat/completions，送 JSON 陣列', async () => {
        const fetchMock = vi.fn(async () => json(200, { choices: [{ message: { content: '["嘿，你還好嗎？"]' } }] }));
        vi.stubGlobal('fetch', fetchMock);
        expect(await translateTexts(['Hey, you okay?'], '繁體中文', base)).toEqual(['嘿，你還好嗎？']);
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://llm.example/v1/chat/completions');
        const body = JSON.parse(String(init.body));
        expect(body.model).toBe('main-model');
        expect(body.messages[1].content).toBe('["Hey, you okay?"]');
    });

    it('Google：帶 key 參數，取 translatedText', async () => {
        const fetchMock = vi.fn(async () => json(200, { data: { translations: [{ translatedText: '你好' }] } }));
        vi.stubGlobal('fetch', fetchMock);
        const out = await translateTexts(['hi'], '繁體中文', { ...base, translationApi: { provider: 'google', googleKey: 'gkey-123456' } });
        expect(out).toEqual(['你好']);
        expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toContain('key=gkey-123456');
        expect(JSON.parse(String(((fetchMock.mock.calls[0] as unknown[])[1] as RequestInit).body)).target).toBe('zh-TW');
    });

    it('Azure：Key 和區域放 header', async () => {
        const fetchMock = vi.fn(async () => json(200, [{ translations: [{ text: '你好' }] }]));
        vi.stubGlobal('fetch', fetchMock);
        await translateTexts(['hi'], '繁體中文', { ...base, translationApi: { provider: 'azure', azureKey: 'akey-123456', azureRegion: 'eastasia' } });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toContain('to=zh-Hant');
        expect((init.headers as Record<string, string>)['Ocp-Apim-Subscription-Region']).toBe('eastasia');
    });

    it('DeepL：經 Worker 的 /deepl-translate，帶共享密鑰', async () => {
        const fetchMock = vi.fn(async () => json(200, { success: true, data: { translations: [{ text: '你好' }] } }));
        vi.stubGlobal('fetch', fetchMock);
        await translateTexts(['hi'], '繁體中文', { ...base, translationApi: { provider: 'deepl', deeplKey: 'dkey:fx' } });
        const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://w.example/deepl-translate');
        expect((init.headers as Record<string, string>)['X-Client-Token']).toBe('tok');
        expect(JSON.parse(String(init.body))).toMatchObject({ authKey: 'dkey:fx', target_lang: 'ZH-HANT' });
    });

    it('不支援的語言直接說，不打 API', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        await expect(translateTexts(['hi'], '粵語', { ...base, translationApi: { provider: 'deepl', deeplKey: 'k' } })).rejects.toThrow('DeepL 不支援「粵語」');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('錯誤訊息裡的 Key 會被換掉', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => json(400, { error: { message: 'bad key gkey-secret-0123456789' } })));
        const err = await translateTexts(['hi'], '繁體中文', { ...base, translationApi: { provider: 'google', googleKey: 'gkey-secret-0123456789' } }).catch(e => e);
        expect(String(err.message)).not.toContain('gkey-secret-0123456789');
        expect(String(err.message)).toContain('[Key]');
    });
});
