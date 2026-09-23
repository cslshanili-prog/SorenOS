import { describe, it, expect } from 'vitest';
import { upgradeChatBodyToStream, assembleUpgradedResponse } from './streamUpgrade';

// 透明流式升級：請求體改寫 + SSE 響應拼回 JSON。
// 關鍵不變量：調用方拿到的最終 JSON 與不升級時結構等價（choices/usage/model）。

describe('upgradeChatBodyToStream', () => {
    it('stream:false → 升級為 stream:true + include_usage，其餘字段不動', () => {
        const out = upgradeChatBodyToStream(JSON.stringify({ model: 'm', messages: [], stream: false, max_tokens: 8000 }));
        const parsed = JSON.parse(out!);
        expect(parsed.stream).toBe(true);
        expect(parsed.stream_options).toEqual({ include_usage: true });
        expect(parsed.max_tokens).toBe(8000);
    });

    it('缺省 stream → 同樣升級', () => {
        const out = upgradeChatBodyToStream(JSON.stringify({ model: 'm', messages: [] }));
        expect(JSON.parse(out!).stream).toBe(true);
    });

    it('已是 stream:true（聊天主路徑等自行開流的調用）→ 不碰，返回 null', () => {
        expect(upgradeChatBodyToStream(JSON.stringify({ model: 'm', stream: true }))).toBeNull();
    });

    it('非 JSON / 非對象 body → 返回 null 原樣放行', () => {
        expect(upgradeChatBodyToStream('not-json')).toBeNull();
        expect(upgradeChatBodyToStream('[1,2]')).toBeNull();
    });
});

describe('assembleUpgradedResponse', () => {
    it('SSE 響應 → 拼回標準 chat.completion JSON', async () => {
        const sse = [
            'data: {"id":"c1","model":"real-backend","choices":[{"delta":{"role":"assistant","content":"你好"}}]}',
            'data: {"choices":[{"delta":{"content":"呀"}}]}',
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        expect(out.headers.get('content-type')).toContain('application/json');
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('你好呀');
        expect(data.model).toBe('real-backend');
        expect(data.usage.total_tokens).toBe(12);
    });

    it('OpenRouter 心跳先於 data 時仍拼回標準 JSON', async () => {
        const sse = [
            ': OPENROUTER PROCESSING',
            '',
            'data: {"id":"c2","choices":[{"delta":{"content":"心跳後"}}]}',
            'data: {"choices":[{"delta":{"content":"正常"}}]}',
            'data: [DONE]',
            '',
        ].join('\n');
        const upstream = new Response(sse, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        const out = await assembleUpgradedResponse(upstream);
        const data = await out.json();
        expect(data.choices[0].message.content).toBe('心跳後正常');
    });

    it('代理無視 stream 返回整包 JSON → 原文透傳（重新包裝）', async () => {
        const json = JSON.stringify({ choices: [{ message: { content: '整包' } }] });
        const upstream = new Response(json, { status: 200, headers: { 'Content-Type': 'application/json' } });
        const out = await assembleUpgradedResponse(upstream);
        expect((await out.json()).choices[0].message.content).toBe('整包');
    });
});
