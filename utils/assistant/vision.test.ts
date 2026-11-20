import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, VisionApiConfig } from '../../types';
import { SORE_IMAGE_MESSAGES_SENT, SORE_PERSONA, toModelMessages } from './engine';
import { describeSoreImages, formatImageNotes, hasImageNotes, SORE_VISION_PROMPT } from './vision';

const user = (id: string, images?: string[], imageNotes?: string[]): AssistantMessage =>
    ({ id, role: 'user', text: id, at: 1, ...(images ? { images } : {}), ...(imageNotes ? { imageNotes } : {}) });
const on: VisionApiConfig = { enabled: true, baseUrl: 'https://v.example/v1', apiKey: 'k', model: 'see' };

describe('Sore 看圖：識圖 API', () => {
    it('沒開識圖：原樣回去，不識別', async () => {
        const describe_ = vi.fn();
        const history = [user('a', ['data:a'])];
        for (const config of [undefined, null, { ...on, enabled: false }]) {
            const out = await describeSoreImages(history, config, { limit: 2, describe: describe_ });
            expect(out).toEqual({ messages: history, changed: false });
        }
        expect(describe_).not.toHaveBeenCalled();
    });

    it('開著：只補會送出去的那幾則、已經有轉述的不重識別，問法是 Sore 自己那套', async () => {
        const describe_ = vi.fn(async (url: string, _config?: unknown, _options?: unknown) => `看到 ${url}`);
        const history = [user('old', ['data:old']), user('b', ['data:b'], ['早就看過']), user('c'), user('d', ['data:d1', 'data:d2'])];
        const out = await describeSoreImages(history, on, { limit: SORE_IMAGE_MESSAGES_SENT, describe: describe_ });
        expect(out.changed).toBe(true);
        expect(describe_.mock.calls.map(c => c[0])).toEqual(['data:d1', 'data:d2']);
        expect(describe_.mock.calls[0][2]).toMatchObject({ prompt: SORE_VISION_PROMPT, keepLines: true, meta: { appName: '助手' } });
        expect(out.messages[3].imageNotes).toEqual(['看到 data:d1', '看到 data:d2']);
        expect(out.messages[0].imageNotes).toBeUndefined();
        expect(out.messages[1].imageNotes).toEqual(['早就看過']);
        // 第二次進來全都有了：不再識別
        const again = await describeSoreImages(out.messages, on, { limit: SORE_IMAGE_MESSAGES_SENT, describe: describe_ });
        expect(again.changed).toBe(false);
        expect(describe_).toHaveBeenCalledTimes(2);
    });

    it('開著但沒填完整、或識圖失敗：丟錯，不偷偷退回直接送圖', async () => {
        await expect(describeSoreImages([user('a', ['data:a'])], { ...on, model: '' }, { limit: 2, describe: vi.fn() })).rejects.toThrow(/識圖 API 開著/);
        await expect(describeSoreImages([user('a', ['data:a'])], on, { limit: 2, describe: async () => { throw new Error('402 額度不夠'); } }))
            .rejects.toThrow('識圖沒成功：402 額度不夠');
    });

    it('按停：丟 AbortError，不包成識圖失敗', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(describeSoreImages([user('a', ['data:a'])], on, { limit: 2, signal: controller.signal, describe: vi.fn() }))
            .rejects.toMatchObject({ name: 'AbortError' });
    });

    it('轉述要一張對一格才算數', () => {
        expect(hasImageNotes(user('a', ['x', 'y'], ['一']))).toBe(false);
        expect(hasImageNotes(user('a', ['x'], ['  ']))).toBe(false);
        expect(hasImageNotes(user('a', ['x'], ['一']))).toBe(true);
        expect(hasImageNotes(user('a'))).toBe(false);
    });
});

describe('Sore 看圖：送給模型的樣子', () => {
    it('有轉述的送文字、不送原圖，太舊的也照帶', () => {
        const history = [user('a', ['data:a'], ['白底藍字']), user('b', ['data:b']), user('c', ['data:c']), user('d', ['data:d'], ['深色頂欄'])];
        const msgs = toModelMessages(history);
        expect(msgs[0].content).toBe(`a\n\n${formatImageNotes(['白底藍字'])}`);
        expect(msgs[3].content).toBe(`d\n\n${formatImageNotes(['深色頂欄'])}`);
        expect(JSON.stringify(msgs[0]) + JSON.stringify(msgs[3])).not.toContain('image_url');
        // 沒轉述的照舊直接送圖，文字上寫明附了幾張
        expect(msgs[2].content).toEqual([{ type: 'text', text: 'c\n（這則附了 1 張圖）' }, { type: 'image_url', image_url: { url: 'data:c' } }]);
    });

    it('轉述寫明是替它看的、標出第幾張', () => {
        const text = formatImageNotes(['一', '二']);
        expect(text).toContain('這則附了 2 張圖');
        expect(text).toContain('【附圖 1】\n一\n【附圖 1 結束】');
        expect(text).toContain('【附圖 2】\n二\n【附圖 2 結束】');
    });

    it('規矩裡有：看不到圖時怪自己這組模型，指兩條路', () => {
        expect(SORE_PERSONA).toContain('這則附了 N 張圖');
        expect(SORE_PERSONA).toContain('識圖 API');
        expect(SORE_PERSONA).toContain('齒輪');
    });
});
