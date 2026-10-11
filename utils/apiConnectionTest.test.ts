import { describe, expect, it, vi } from 'vitest';
import { testChatModel } from './apiConnectionTest';

const target = { baseUrl: 'https://api.test/v1/', apiKey: 'sk-x', model: 'gpt-4o' };
const json = (body: unknown, status = 200) => async () => new Response(JSON.stringify(body), { status });

describe('testChatModel', () => {
    it('真的用選的模型發一句：打 chat/completions、帶上模型名', async () => {
        const fetchImpl = vi.fn(json({ model: 'gpt-4o-2024-08-06', choices: [{ message: { content: 'Hello!' } }] }));
        const r = await testChatModel(target, { fetchImpl });
        expect(r).toEqual({ ok: true, message: '✅ 模型回覆：「Hello!」' });
        const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
        expect(url).toBe('https://api.test/v1/chat/completions');
        expect(JSON.parse(String(init.body)).model).toBe('gpt-4o');
    });

    it('沒選模型就不測', async () => {
        const fetchImpl = vi.fn();
        expect((await testChatModel({ ...target, model: ' ' }, { fetchImpl })).ok).toBe(false);
        expect(fetchImpl).not.toHaveBeenCalled();
    });

    it('HTTP 錯誤、200 但帶 error、沒有 choices、空白回覆都算失敗', async () => {
        expect((await testChatModel(target, { fetchImpl: json({ error: { message: 'model not found' } }, 404) })).message).toMatch(/^❌ HTTP 404/);
        expect((await testChatModel(target, { fetchImpl: json({ error: { message: 'upstream down' } }) })).message).toBe('❌ 模型回報錯誤：upstream down');
        expect((await testChatModel(target, { fetchImpl: json({ object: 'list', data: [] }) })).ok).toBe(false);
        expect((await testChatModel(target, { fetchImpl: json({ choices: [{ message: { content: '' }, finish_reason: 'stop' }] }) })).ok).toBe(false);
    });

    it('推理模型被長度截斷算有回應；中轉偷換模型會寫出來', async () => {
        const cut = await testChatModel(target, { fetchImpl: json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }) });
        expect(cut.ok).toBe(true);
        const swapped = await testChatModel(target, { fetchImpl: json({ model: 'deepseek-chat', choices: [{ message: { content: 'hi' } }] }) });
        expect(swapped).toEqual({ ok: true, message: '✅ 模型回覆：「hi」（實際回覆的模型是 deepseek-chat）' });
    });

    it('網路錯誤寫原因', async () => {
        const r = await testChatModel(target, { fetchImpl: async () => { throw new TypeError('Failed to fetch'); } });
        expect(r).toEqual({ ok: false, message: '❌ 連接失敗：Failed to fetch' });
    });
});
