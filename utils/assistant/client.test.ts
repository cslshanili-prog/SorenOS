import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeSoreCall, scrubSecret, stripThinkTags, testApiConnection } from './client';

const KEY = 'sk-test-abcdefghijklmnopqrstuvwxyz123456';

afterEach(() => vi.restoreAllMocks());

describe('scrubSecret', () => {
    it('整串 Key、前段、後段都換掉', () => {
        expect(scrubSecret(`401 invalid key ${KEY}`, KEY)).not.toContain('abcdefghij');
        expect(scrubSecret(`key ${KEY.slice(0, 12)}*** invalid`, KEY)).toContain('[Key]');
        expect(scrubSecret(`key ***${KEY.slice(-12)} invalid`, KEY)).toContain('[Key]');
    });
    it('沒給 Key 也會遮 sk- 開頭的長字串', () => {
        expect(scrubSecret('Incorrect API key provided: sk-proj-AAAABBBBCCCCDDDD')).toBe('Incorrect API key provided: [Key]');
    });
});

describe('testApiConnection', () => {
    it('沒填網址、模型不打請求', async () => {
        const spy = vi.spyOn(globalThis, 'fetch');
        expect(await testApiConnection(undefined)).toEqual({ ok: false, message: '網址沒填' });
        expect(await testApiConnection({ baseUrl: 'https://x/v1', model: '' })).toEqual({ ok: false, message: '模型沒填' });
        expect(spy).not.toHaveBeenCalled();
    });
    it('失敗訊息不帶 Key', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ error: { message: `bad key ${KEY}` } }), { status: 401, headers: { 'Content-Type': 'application/json' } }));
        const result = await testApiConnection({ baseUrl: 'https://x/v1/', apiKey: KEY, model: 'm' });
        expect(result.ok).toBe(false);
        expect(result.message).not.toContain(KEY);
        expect(result.message).not.toContain('abcdefghijkl');
    });
    it('成功', async () => {
        const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const result = await testApiConnection({ baseUrl: 'https://x/v1/', apiKey: KEY, model: 'm' });
        expect(result.ok).toBe(true);
        expect(String(spy.mock.calls[0][0])).toBe('https://x/v1/chat/completions');
    });
});

describe('makeSoreCall', () => {
    it('回覆拿 content，錯誤不帶 Key', async () => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: '嗨' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        const call = makeSoreCall({ baseUrl: 'https://x/v1', apiKey: KEY, model: 'm' });
        expect(await call([{ role: 'user', content: 'hi' }])).toBe('嗨');
        vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response(`nope ${KEY}`, { status: 403 }));
        await expect(call([{ role: 'user', content: 'hi' }])).rejects.toThrow(/^(?!.*abcdefghijkl)/);
    });
});

describe('stripThinkTags', () => {
    it('剝思考標籤，「我先看一下」這種正常的話留著', () => {
        expect(stripThinkTags('<think>想想</think>我先看一下你的設定。\n<tool name="查看設定概況">{}</tool>')).toBe('我先看一下你的設定。\n<tool name="查看設定概況">{}</tool>');
        expect(stripThinkTags('分析一堆</think>\n好了')).toBe('好了');
        expect(stripThinkTags('讓我看看現在的狀況')).toBe('讓我看看現在的狀況');
    });
});
