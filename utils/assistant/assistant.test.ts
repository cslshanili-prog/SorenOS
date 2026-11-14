import { describe, it, expect } from 'vitest';
import { looseJson, parseAssistantReply, formatToolResult } from './protocol';
import { resolveSoreApi } from './api';
import { describeSettings } from './tools';
import { runSoreTurn, buildSoreSystemPrompt, SORE_MAX_TOOL_ROUNDS } from './engine';
import { SORE_GUIDES } from './knowledge';

describe('Sore 文字協議', () => {
    it('讀出工具、拿掉標籤留下給人看的字', () => {
        const r = parseAssistantReply('我看一下你的設定 👀\n<tool name="查看設定概況">{}</tool>');
        expect(r.visible).toBe('我看一下你的設定 👀');
        expect(r.calls).toEqual([{ name: '查看設定概況', args: {} }]);
    });
    it('一次好幾個、全形引號、尾逗號、沒閉合都收', () => {
        const r = parseAssistantReply('<tool name="測試API">{“target”: “light”,}</tool>\n<tool name=“讀說明”>{"topic": "api"');
        expect(r.calls).toEqual([{ name: '測試API', args: { target: 'light' } }, { name: '讀說明', args: { topic: 'api' } }]);
        expect(r.visible).toBe('');
    });
    it('參數讀不出來就是空物件；模型抄了 tool_result 也拿掉', () => {
        expect(looseJson('不是 JSON')).toEqual({});
        expect(parseAssistantReply('好\n<tool_result name="x" ok="true">\n抄的\n</tool_result>').visible).toBe('好');
        expect(formatToolResult('讀說明', true, '內容')).toBe('<tool_result name="讀說明" ok="true">\n內容\n</tool_result>');
    });
});

describe('Sore 用哪組 API', () => {
    const apiConfig: any = { baseUrl: 'https://g/v1', apiKey: 'k', model: 'big' };
    const lightLLM = { baseUrl: 'https://l/v1', apiKey: 'k2', model: 'small' };
    const apiPresets: any = [{ id: 'p1', name: '便宜的', config: { baseUrl: 'https://p/v1', apiKey: 'k3', model: 'mid' } }];
    it('自動：副 API 優先，沒設才用全域', () => {
        expect(resolveSoreApi('auto', { apiConfig, lightLLM })?.model).toBe('small');
        expect(resolveSoreApi('auto', { apiConfig })?.model).toBe('big');
    });
    it('指定全域、API 庫；庫裡那組被刪了往下退', () => {
        expect(resolveSoreApi('global', { apiConfig, lightLLM })?.label).toBe('全域 API');
        expect(resolveSoreApi('preset:p1', { apiConfig, lightLLM, apiPresets })?.label).toBe('API 庫 · 便宜的');
        expect(resolveSoreApi('preset:gone', { apiConfig, lightLLM, apiPresets })?.model).toBe('small');
        expect(resolveSoreApi('auto', { apiConfig: { baseUrl: '', apiKey: '', model: '' } as any })).toBeNull();
    });
});

describe('設定概況不洩漏 Key', () => {
    it('只說有沒有', () => {
        const text = describeSettings({
            apiConfig: { baseUrl: 'https://g/v1', apiKey: 'sk-secret-123', model: 'big', minimaxApiKey: 'mm-secret' } as any,
            lightLLM: { baseUrl: 'https://l', apiKey: 'sk-light-secret', model: 'small' },
            apiPresetCount: 1, characters: [{ id: 'c1', name: '阿澈', activeMsg2Config: { enabled: true } as any }], groups: [],
            amsgWorkerUrl: 'https://worker.example/secret-path',
        });
        expect(text).not.toMatch(/secret/);
        expect(text).toContain('模型 big');
        expect(text).toContain('副 API（記憶宮殿）：有設，模型 small');
        expect(text).toContain('開了 2.0 的角色 1 個');
    });
});

describe('Sore 的一輪', () => {
    const ctx = {
        settings: async () => ({ apiConfig: { baseUrl: '', apiKey: '', model: '' } as any, apiPresetCount: 0, characters: [], groups: [] }),
        testApi: async () => ({ ok: false, message: 'HTTP 401' }),
    };
    it('叫工具 → 回結果 → 再答；工具結果當 user 回給模型', async () => {
        const replies = ['我看看 <tool name="查看設定概況">{}</tool>', '你根本沒填 API 啊 😅'];
        const seen: any[] = [];
        const out = await runSoreTurn({
            history: [{ id: 'u', role: 'user', text: '角色怎麼不回我', at: 0 }],
            call: async (messages) => { seen.push(messages); return replies.shift()!; },
            ctx, onMessage: () => {},
        });
        expect(out.map(m => m.role)).toEqual(['assistant', 'tool', 'assistant']);
        expect(out[1].text).toContain('全域 API：網址沒有');
        const second = seen[1];
        expect(second[second.length - 1].role).toBe('user');
        expect(second[second.length - 1].content).toContain('<tool_result name="查看設定概況" ok="true">');
        expect(second[second.length - 2].content).toContain('<tool name="查看設定概況">');
        expect(out[2].text).toBe('你根本沒填 API 啊 😅');
    });
    it('沒有的工具回錯誤；一直叫工具會停在上限', async () => {
        let calls = 0;
        const out = await runSoreTurn({
            history: [{ id: 'u', role: 'user', text: '?', at: 0 }],
            call: async () => { calls++; return '<tool name="亂叫">{}</tool>'; },
            ctx, onMessage: () => {},
        });
        expect(calls).toBe(SORE_MAX_TOOL_ROUNDS + 1);
        expect(out[1].text).toContain('沒有「亂叫」這個工具');
        expect(out[out.length - 1].text).toContain('查太多次了');
    });
    it('系統提示詞帶人設、工具、知識；說明都有內容', () => {
        const sys = buildSoreSystemPrompt({ entryNote: '從聊天白框來的' });
        expect(sys).toContain('你是 Sore');
        expect(sys).toContain('<tool name="工具名">');
        expect(sys).toContain('讀說明');
        expect(sys).toContain('# 用戶從哪裡來');
        expect(sys).toContain('發了消息，角色不回我？');
        for (const g of SORE_GUIDES) expect(g.content.length).toBeGreaterThan(50);
    });
});
