import { describe, expect, it } from 'vitest';
import { mergeSystemMessages } from './systemMessageMerge';

describe('mergeSystemMessages', () => {
    it('三段式請求：穩定前綴 + 易變尾段 + 提醒條合併成開頭一條，歷史順序不動', () => {
        const messages = [
            { role: 'system', content: '穩定前綴' },
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '嗨' },
            { role: 'system', content: '易變尾段' },
            { role: 'system', content: '[MCP 提醒]' },
        ];
        const merged = mergeSystemMessages(messages);
        expect(merged).toEqual([
            { role: 'system', content: '穩定前綴\n\n易變尾段\n\n[MCP 提醒]' },
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '嗨' },
        ]);
        // 原數組不被改動
        expect(messages).toHaveLength(5);
    });

    it('只有一條 system 時原樣返回（同一引用，不重建）', () => {
        const messages = [
            { role: 'system', content: '唯一 system' },
            { role: 'user', content: 'hi' },
        ];
        expect(mergeSystemMessages(messages)).toBe(messages);
    });

    it('沒有 system 時原樣返回', () => {
        const messages = [{ role: 'user', content: 'hi' }];
        expect(mergeSystemMessages(messages)).toBe(messages);
    });

    it('空白 system 段被丟棄，不產生多餘空行', () => {
        const messages = [
            { role: 'system', content: 'A' },
            { role: 'system', content: '   ' },
            { role: 'system', content: 'B' },
        ];
        expect(mergeSystemMessages(messages)[0].content).toBe('A\n\nB');
    });
});
