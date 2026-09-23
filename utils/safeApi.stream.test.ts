import { describe, it, expect, vi, afterEach } from 'vitest';
import { safeFetchJson } from './safeApi';

// 鎖住流式讀取路徑 (readBodyWithStreaming) 與整包路徑的行為一致性：
//  - SSE 增量正文觸發 onDelta，最終拼出與非流式相同結構的 completion 對象
//  - tool_calls 分片按 index 合併（工具模式開 stream 不丟調用）
//  - 代理無視 stream:true 返回整包 JSON 時靜默退化，onDelta 不觸發

const sseBody = (events: string[]) => new ReadableStream<Uint8Array>({
    start(controller) {
        const enc = new TextEncoder();
        for (const e of events) controller.enqueue(enc.encode(e));
        controller.close();
    },
});

const sseResponse = (events: string[]) => new Response(sseBody(events), {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
});

const lingeringSseResponse = (events: string[], onCancel: () => void) => new Response(
    new ReadableStream<Uint8Array>({
        start(controller) {
            const enc = new TextEncoder();
            for (const event of events) controller.enqueue(enc.encode(event));
            // Deliberately never close: some compatible Claude proxies leave the
            // socket alive even after their terminal SSE event.
        },
        cancel() { onCancel(); },
    }),
    { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
);

afterEach(() => vi.restoreAllMocks());

describe('safeFetchJson streaming', () => {
    it('SSE 增量觸發 onDelta 且最終 completion 與整包解析一致', async () => {
        const events = [
            'data: {"id":"x","choices":[{"delta":{"role":"assistant","content":"你好"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"呀\\n在幹嘛"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"total_tokens":42,"prompt_tokens":30,"completion_tokens":12}}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

        const deltas: string[] = [];
        let lastFull = '';
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d, full) => { deltas.push(d); lastFull = full; },
        });

        expect(deltas.join('')).toBe('你好呀\n在幹嘛');
        expect(lastFull).toBe('你好呀\n在幹嘛');
        expect(data.choices[0].message.content).toBe('你好呀\n在幹嘛');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(data.usage.total_tokens).toBe(42);
    });

    it('收到 [DONE] 後立即收口，不等待代理主動關閉連接', async () => {
        const cancelled = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => lingeringSseResponse([
            'data: {"choices":[{"delta":{"content":"已經生成完"}}]}\n\n',
            'data: [DONE]\n\n',
        ], cancelled)));

        const data = await safeFetchJson(
            'https://api.test/v1/chat/completions',
            { method: 'POST', body: '{"stream":true}' },
            0,
            0,
            undefined,
            {},
        );
        expect(data.choices[0].message.content).toBe('已經生成完');
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('缺少 [DONE] 時也可由 finish_reason 收口長連接', async () => {
        const cancelled = vi.fn();
        vi.stubGlobal('fetch', vi.fn(async () => lingeringSseResponse([
            'data: {"choices":[{"delta":{"content":"最後正文"}}]}\n\n',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n',
        ], cancelled)));

        const data = await safeFetchJson(
            'https://api.test/v1/chat/completions',
            { method: 'POST', body: '{"stream":true}' },
            0,
            0,
            undefined,
            {},
        );
        expect(data.choices[0].message.content).toBe('最後正文');
        expect(data.choices[0].finish_reason).toBe('stop');
        expect(cancelled).toHaveBeenCalledOnce();
    });

    it('tool_calls 分片按 index 合併，不因流式丟失', async () => {
        const events = [
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"propose_cart_items","arguments":"{\\"items\\""}}]}}]}\n\n',
            'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":[]}"}}]}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));

        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, { onDelta: () => {} });
        const tc = data.choices[0].message.tool_calls;
        expect(tc).toHaveLength(1);
        expect(tc[0].id).toBe('call_1');
        expect(tc[0].function.name).toBe('propose_cart_items');
        expect(tc[0].function.arguments).toBe('{"items":[]}');
    });

    it('代理返回整包 JSON（無視 stream）時退化解析，onDelta 不觸發', async () => {
        const json = { choices: [{ message: { role: 'assistant', content: '整包回覆' }, finish_reason: 'stop' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(json), {
            status: 200, headers: { 'Content-Type': 'application/json' },
        })));

        const deltas: string[] = [];
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d) => { deltas.push(d); },
        });
        expect(deltas).toEqual([]);
        expect(data.choices[0].message.content).toBe('整包回覆');
    });

    it('代理把整包 JSON 錯標為 event-stream 時仍按 JSON 解析', async () => {
        const json = { choices: [{ message: { role: 'assistant', content: '錯標但有效' }, finish_reason: 'stop' }] };
        vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(json), {
            status: 200, headers: { 'Content-Type': 'text/event-stream' },
        })));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0);
        expect(data.choices[0].message.content).toBe('錯標但有效');
    });

    it('不傳 streamHooks 時對 SSE 響應仍走整包拼接（舊行為不變）', async () => {
        const events = [
            'data: {"choices":[{"delta":{"content":"a"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"b"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0);
        expect(data.choices[0].message.content).toBe('ab');
    });

    it('不傳 streamHooks 時忽略 OpenRouter 心跳並繼續拼接 data', async () => {
        const events = [
            ': OPENROUTER PROCESSING\n\n',
            ': OPENROUTER PROCESSING\n\n',
            'data: {"choices":[{"delta":{"content":"印象"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"完成"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0);
        expect(data.choices[0].message.content).toBe('印象完成');
    });

    it('真流式讀取時首塊只有 OpenRouter 心跳也不會誤判為普通文本', async () => {
        const events = [
            ': OPENROUTER PROCESSING\n\n',
            'data: {"choices":[{"delta":{"content":"正常"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const deltas: string[] = [];
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: delta => { deltas.push(delta); },
        });
        expect(deltas).toEqual(['正常']);
        expect(data.choices[0].message.content).toBe('正常');
    });

    it('只有心跳就結束時明確報流式無有效數據，不偽造成功結果', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse([
            ': OPENROUTER PROCESSING\n\n',
            ': OPENROUTER PROCESSING\n\n',
        ])));
        await expect(
            safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0),
        ).rejects.toThrow('API流式響應未返回有效數據');
    });
});

describe('SSE 拼裝保留思考通道 (reasoning_content)', () => {
    it('delta.reasoning_content 累積進 message.reasoning_content（思維鏈顯示依賴它）', async () => {
        const events = [
            'data: {"choices":[{"delta":{"reasoning_content":"她這句是在"}}]}\n\n',
            'data: {"choices":[{"delta":{"reasoning_content":"逗我玩…"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"哼，看穿你了"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const reasoningDeltas: string[] = [];
        let fullReasoning = '';
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: () => {},
            onReasoningDelta: (delta, full) => { reasoningDeltas.push(delta); fullReasoning = full; },
        });
        expect(data.choices[0].message.reasoning_content).toBe('她這句是在逗我玩…');
        expect(data.choices[0].message.content).toBe('哼，看穿你了');
        expect(reasoningDeltas.join('')).toBe('她這句是在逗我玩…');
        expect(fullReasoning).toBe('她這句是在逗我玩…');
    });

    it('OpenRouter 形態 delta.reasoning 同樣保留，並通過獨立回調實時吐出思考', async () => {
        const events = [
            'data: {"choices":[{"delta":{"reasoning":"thinking..."}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"回覆正文"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const deltas: string[] = [];
        const reasoningDeltas: string[] = [];
        let fullReasoning = '';
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d) => { deltas.push(d); },
            onReasoningDelta: (d, full) => { reasoningDeltas.push(d); fullReasoning = full; },
        });
        expect(data.choices[0].message.reasoning_content).toBe('thinking...');
        expect(deltas.join('')).toBe('回覆正文');
        expect(reasoningDeltas.join('')).toBe('thinking...');
        expect(fullReasoning).toBe('thinking...');
    });

    it('沒有思考通道時不產生空的 reasoning_content 字段', async () => {
        const events = ['data: {"choices":[{"delta":{"content":"普通回覆"}}]}\n\n', 'data: [DONE]\n'];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, { onDelta: () => {} });
        expect(data.choices[0].message).not.toHaveProperty('reasoning_content');
    });
});

describe('SSE 思考通道的更多字段形狀（Claude 官轉/CC 渠道）', () => {
    it('delta.thinking 字符串形態保留', async () => {
        const events = [
            'data: {"choices":[{"delta":{"thinking":"內心 os…"}}]}\n\n',
            'data: {"choices":[{"delta":{"content":"正文"}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, { onDelta: () => {} });
        expect(data.choices[0].message.reasoning_content).toBe('內心 os…');
        expect(data.choices[0].message.content).toBe('正文');
    });

    it('Anthropic 透傳分塊 content：text 進正文、thinking 進思考', async () => {
        const events = [
            'data: {"choices":[{"delta":{"content":[{"type":"thinking","thinking":"想一下…"},{"type":"text","text":"你好"}]}}]}\n\n',
            'data: {"choices":[{"delta":{"content":[{"type":"text","text":"呀"}]}}]}\n\n',
            'data: [DONE]\n',
        ];
        vi.stubGlobal('fetch', vi.fn(async () => sseResponse(events)));
        const deltas: string[] = [];
        const reasoningDeltas: string[] = [];
        const data = await safeFetchJson('https://api.test/v1/chat/completions', { method: 'POST', body: '{}' }, 0, 0, undefined, {
            onDelta: (d) => { deltas.push(d); },
            onReasoningDelta: (d) => { reasoningDeltas.push(d); },
        });
        expect(data.choices[0].message.content).toBe('你好呀');
        expect(data.choices[0].message.reasoning_content).toBe('想一下…');
        expect(deltas.join('')).toBe('你好呀');
        expect(reasoningDeltas.join('')).toBe('想一下…');
    });
});
