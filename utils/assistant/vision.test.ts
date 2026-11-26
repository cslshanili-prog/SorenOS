import { describe, expect, it, vi } from 'vitest';
import type { AssistantMessage, VisionApiConfig } from '../../types';
import { SORE_IMAGE_MESSAGES_SENT, SORE_PERSONA, toModelMessages } from './engine';
import { describeSoreImages, dropFailedNotes, failedImageCount, formatImageNotes, hasAnyImageNote, imagesHandled, SORE_VISION_PROMPT, SORE_VISION_TIMEOUT_MS } from './vision';

const user = (id: string, images?: string[], imageNotes?: string[], imageNoteErrors?: string[]): AssistantMessage =>
    ({ id, role: 'user', text: id, at: 1, ...(images ? { images } : {}), ...(imageNotes ? { imageNotes } : {}), ...(imageNoteErrors ? { imageNoteErrors } : {}) });
const on: VisionApiConfig = { enabled: true, baseUrl: 'https://v.example/v1', apiKey: 'sk-secret-vision-key-123', model: 'see' };
const ok = () => vi.fn(async (url: string, _config?: unknown, _options?: unknown) => `看到 ${url}`);

describe('Sore 看圖：識圖 API', () => {
    it('沒開識圖：原樣回去，不識別', async () => {
        const describe_ = vi.fn();
        const history = [user('a', ['data:a'])];
        for (const config of [undefined, null, { ...on, enabled: false }]) {
            const out = await describeSoreImages(history, config, { limit: 2, describe: describe_ });
            expect(out).toEqual({ messages: history, changed: false, failed: 0 });
        }
        expect(describe_).not.toHaveBeenCalled();
    });

    it('開著：只補會送出去的那幾則、已經有轉述的不重識別，問法和逾時是 Sore 自己那套', async () => {
        const describe_ = ok();
        const history = [user('old', ['data:old']), user('b', ['data:b'], ['早就看過']), user('c'), user('d', ['data:d1', 'data:d2'])];
        const out = await describeSoreImages(history, on, { limit: SORE_IMAGE_MESSAGES_SENT, describe: describe_ });
        expect(out.changed).toBe(true);
        expect(out.failed).toBe(0);
        expect(describe_.mock.calls.map(c => c[0]).sort()).toEqual(['data:d1', 'data:d2']);
        expect(describe_.mock.calls[0][2]).toMatchObject({ prompt: SORE_VISION_PROMPT, keepLines: true, timeoutMs: SORE_VISION_TIMEOUT_MS, meta: { appName: '助手' } });
        expect(SORE_VISION_TIMEOUT_MS).toBeGreaterThan(60_000);
        expect(out.messages[3].imageNotes).toEqual(['看到 data:d1', '看到 data:d2']);
        expect(out.messages[3].imageNoteErrors).toBeUndefined();
        expect(out.messages[0].imageNotes).toBeUndefined();
        expect(out.messages[1].imageNotes).toEqual(['早就看過']);
        const again = await describeSoreImages(out.messages, on, { limit: SORE_IMAGE_MESSAGES_SENT, describe: describe_ });
        expect(again.changed).toBe(false);
        expect(describe_).toHaveBeenCalledTimes(2);
    });

    it('識圖沒成功不丟錯：成功的照記，沒成功的記原因（Key 換掉）', async () => {
        const describe_ = vi.fn(async (url: string) => { if (url === 'data:bad') throw new Error('402 額度不夠 sk-secret-vision-key-123'); return '白底'; });
        const out = await describeSoreImages([user('a', ['data:good', 'data:bad'])], on, { limit: 2, describe: describe_ });
        expect(out.failed).toBe(1);
        expect(out.messages[0].imageNotes).toEqual(['白底', '']);
        expect(out.messages[0].imageNoteErrors).toEqual(['', '402 額度不夠 [Key]']);
        expect(imagesHandled(out.messages[0])).toBe(true);
        expect(failedImageCount(out.messages[0])).toBe(1);
        expect(hasAnyImageNote(out.messages[0])).toBe(true);
    });

    it('逾時（瀏覽器給的是 AbortError）算識圖沒成功，不是用戶按停', async () => {
        const timeout = Object.assign(new Error('Fetch is aborted'), { name: 'AbortError' });
        const out = await describeSoreImages([user('a', ['data:a'])], on, { limit: 2, signal: new AbortController().signal, describe: async () => { throw timeout; } });
        expect(out.failed).toBe(1);
        expect(out.messages[0].imageNoteErrors).toEqual(['等了 120 秒識圖模型沒回']);
    });

    it('沒成功的不會每輪自動再試（不然又卡在識圖）；按重試才再試那一則', async () => {
        const describe_ = ok();
        const failed = [user('a', ['data:a'], [''], ['逾時']), user('b', ['data:b'], [''], ['逾時'])];
        const next = await describeSoreImages(failed, on, { limit: SORE_IMAGE_MESSAGES_SENT, describe: describe_ });
        expect(next.changed).toBe(false);
        expect(describe_).not.toHaveBeenCalled();
        const retried = await describeSoreImages(failed, on, { limit: 0, retryIds: ['a'], describe: describe_ });
        expect(describe_.mock.calls.map(c => c[0])).toEqual(['data:a']);
        expect(retried.failed).toBe(0);
        expect(retried.messages[0].imageNotes).toEqual(['看到 data:a']);
        expect(retried.messages[0].imageNoteErrors).toBeUndefined();
        expect(retried.messages[1]).toBe(failed[1]);
    });

    it('重試只跑沒成功的那幾張，成功過的不重跑', async () => {
        const describe_ = ok();
        const out = await describeSoreImages([user('a', ['data:1', 'data:2'], ['早就看過', ''], ['', '逾時'])], on, { limit: 0, retryIds: ['a'], describe: describe_ });
        expect(describe_.mock.calls.map(c => c[0])).toEqual(['data:2']);
        expect(out.messages[0].imageNotes).toEqual(['早就看過', '看到 data:2']);
    });

    it('開著但沒填完整：記成沒成功，不打請求也不丟錯', async () => {
        const describe_ = vi.fn();
        const out = await describeSoreImages([user('a', ['data:a'])], { ...on, model: '' }, { limit: 2, describe: describe_ });
        expect(describe_).not.toHaveBeenCalled();
        expect(out.failed).toBe(1);
        expect(out.messages[0].imageNoteErrors?.[0]).toContain('沒填完整');
    });

    it('用戶按停：丟 AbortError，不記成識圖沒成功', async () => {
        const before = new AbortController();
        before.abort();
        await expect(describeSoreImages([user('a', ['data:a'])], on, { limit: 2, signal: before.signal, describe: vi.fn() })).rejects.toMatchObject({ name: 'AbortError' });
        const during = new AbortController();
        const describe_ = vi.fn(async () => { during.abort(); throw Object.assign(new Error('aborted'), { name: 'AbortError' }); });
        await expect(describeSoreImages([user('a', ['data:a'])], on, { limit: 2, signal: during.signal, describe: describe_ })).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('識圖關掉後：整則沒成功的清掉記錄（改成直接送原圖），有轉述的不動', () => {
        const history = [user('a', ['data:a'], [''], ['逾時']), user('b', ['data:1', 'data:2'], ['白底', ''], ['', '逾時']), user('c')];
        const out = dropFailedNotes(history);
        expect(out.changed).toBe(true);
        expect(out.messages[0].imageNotes).toBeUndefined();
        expect(out.messages[0].imageNoteErrors).toBeUndefined();
        expect(out.messages[1]).toBe(history[1]);
        expect(dropFailedNotes(out.messages).changed).toBe(false);
    });
});

describe('Sore 看圖：送給模型的樣子', () => {
    it('過了識圖的送文字、不送原圖，太舊的也照帶；沒過的照舊直接送圖', () => {
        const history = [user('a', ['data:a'], ['白底藍字']), user('b', ['data:b']), user('c', ['data:c']), user('d', ['data:d'], ['深色頂欄'])];
        const msgs = toModelMessages(history);
        expect(msgs[0].content).toBe(`a\n\n${formatImageNotes(history[0])}`);
        expect(msgs[3].content).toBe(`d\n\n${formatImageNotes(history[3])}`);
        expect(JSON.stringify(msgs[0]) + JSON.stringify(msgs[3])).not.toContain('image_url');
        expect(msgs[2].content).toEqual([{ type: 'text', text: 'c\n（這則附了 1 張圖）' }, { type: 'image_url', image_url: { url: 'data:c' } }]);
    });

    it('識圖沒成功的那則照樣送出去：文字寫明沒看到和原因，不帶原圖', () => {
        const allFailed = user('x', ['data:x'], [''], ['等了 120 秒識圖模型沒回']);
        const msgs = toModelMessages([allFailed]);
        expect(typeof msgs[0].content).toBe('string');
        expect(msgs[0].content).toContain('識圖這次沒成功，圖你都沒看到');
        expect(msgs[0].content).toContain('【附圖 1】識圖沒成功（等了 120 秒識圖模型沒回），這張你沒看到。');
        const partly = formatImageNotes(user('y', ['1', '2'], ['白底', ''], ['', '402']));
        expect(partly).toContain('其中 1 張識圖沒成功');
        expect(partly).toContain('【附圖 1】\n白底\n【附圖 1 結束】');
        expect(partly).toContain('【附圖 2】識圖沒成功（402），這張你沒看到。');
    });

    it('規矩裡有：看不到圖時怪自己這組模型；識圖沒成功別裝作看到', () => {
        expect(SORE_PERSONA).toContain('這則附了 N 張圖');
        expect(SORE_PERSONA).toContain('API 配置 → 識圖');
        expect(SORE_PERSONA).toContain('齒輪');
        expect(SORE_PERSONA).toContain('識圖沒成功');
    });
});
