import { afterEach, describe, expect, it, vi } from 'vitest';
import { DB } from './db';
import { translateCloudReply, translateMessagesInPlace, postTranslateRecentReplies } from './chatTranslateRun';
import type { APIConfig } from '../types';

const api = { baseUrl: 'https://llm.example/v1', apiKey: 'sk-test-0123456789abcdef', model: 'm' } as APIConfig;
const reply = (arr: string[]) => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(arr) } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });

afterEach(() => { vi.unstubAllGlobals(); });

const seed = async (charId: string) => {
    await DB.saveMessage({ charId, role: 'user', type: 'text', content: 'hi' } as any);
    const a = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: 'Hey, you okay?', metadata: { activeMsg2: { messageId: 'push-1' } } } as any);
    const b = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: 'Already\n%%BILINGUAL%%\n已經', metadata: { activeMsg2: { messageId: 'push-1' } } } as any);
    const c = await DB.saveMessage({ charId, role: 'assistant', type: 'text', content: 'Other push', metadata: { activeMsg2: { messageId: 'push-2' } } } as any);
    return { a, b, c };
};
const contentOf = async (charId: string, id: number) => (await DB.getRecentMessagesByCharId(charId, 20)).find(m => m.id === id);

describe('chatTranslateRun', () => {
    it('雲端回覆：只翻這一條 push 的 TA 的氣泡，已是雙語的不重翻', async () => {
        const { a, b, c } = await seed('cl1');
        const fetchMock = vi.fn(async () => reply(['嘿，你還好嗎？']));
        vi.stubGlobal('fetch', fetchMock);
        const n = await translateCloudReply('cl1', 'push-1', { speak: 'English', translateTo: '繁體中文' }, api);
        expect(n).toBe(1);
        expect((await contentOf('cl1', a))?.content).toBe('Hey, you okay?\n%%BILINGUAL%%\n嘿，你還好嗎？');
        expect((await contentOf('cl1', b))?.content).toBe('Already\n%%BILINGUAL%%\n已經');
        expect((await contentOf('cl1', c))?.content).toBe('Other push');
    });

    it('雲端回覆：選「順便翻」的角色也要補（雲端一律不帶標籤）；沒設翻譯就不動', async () => {
        await seed('cl2');
        const fetchMock = vi.fn(async () => reply(['嘿']));
        vi.stubGlobal('fetch', fetchMock);
        expect(await translateCloudReply('cl2', 'push-1', { speak: 'English', translateTo: '繁體中文', translator: 'chat' }, api)).toBe(1);
        expect(await translateCloudReply('cl2', 'push-2', { speak: 'English' }, api)).toBe(0);
    });

    it('本地回覆：只有先寫再翻才翻', async () => {
        await seed('cl3');
        vi.stubGlobal('fetch', vi.fn(async () => reply(['a', 'b'])));
        expect(await postTranslateRecentReplies('cl3', 0, { speak: 'English', translateTo: '繁體中文' }, api)).toBe(0);
        expect(await postTranslateRecentReplies('cl3', 0, { speak: 'English', translateTo: '繁體中文', translator: 'api' }, api)).toBe(2);
    });

    it('翻不成：標 translationFailed，再翻成功後拿掉', async () => {
        const { a } = await seed('cl4');
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":{"message":"boom"}}', { status: 400 })));
        const target = (await contentOf('cl4', a))!;
        expect(await translateMessagesInPlace([target], '繁體中文', api)).toBe(0);
        expect((await contentOf('cl4', a))?.metadata?.translationFailed).toBeTruthy();
        vi.stubGlobal('fetch', vi.fn(async () => reply(['嘿'])));
        expect(await translateMessagesInPlace([(await contentOf('cl4', a))!], '繁體中文', api)).toBe(1);
        const after = await contentOf('cl4', a);
        expect(after?.content).toContain('%%BILINGUAL%%');
        expect(after?.metadata?.translationFailed).toBeUndefined();
    });
});

describe('雲端收件接線', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    it('收件後處理落庫之後才補譯文，用這條 push 的 messageId 認氣泡', () => {
        const src = fs.readFileSync(path.resolve(__dirname, 'activeMsgRuntime.ts'), 'utf8');
        const post = src.indexOf('await applyAssistantPostProcessing(message.body');
        const tr = src.indexOf('translateCloudReply(lineArgOf(char), message.messageId');
        expect(post).toBeGreaterThan(0);
        expect(tr).toBeGreaterThan(post);
    });
    it('即時對話送出去的提示詞不帶雙語標籤', () => {
        const src = fs.readFileSync(path.resolve(__dirname, '../hooks/useChatAI.ts'), 'utf8');
        expect(src).toContain('chatLanguage: instantChatRoute ? chatLanguageForCloud(chatLanguage) : chatLanguage');
    });
});
