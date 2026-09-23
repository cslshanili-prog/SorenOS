import { describe, expect, it } from 'vitest';
import { getPendingReplyText } from './pendingReply';

describe('getPendingReplyText', () => {
    it('最後一條是未回覆用戶消息時返回 content', () => {
        expect(getPendingReplyText([
            { role: 'assistant', content: '在嗎' },
            { role: 'user', content: '  在的  ' },
        ])).toBe('在的');
    });

    it('兼容通話氣泡的 text 字段', () => {
        expect(getPendingReplyText([{ role: 'user', text: '再說一次' }])).toBe('再說一次');
    });

    it('最後已經有助手回覆時不進入重試', () => {
        expect(getPendingReplyText([
            { role: 'user', content: '你好' },
            { role: 'assistant', content: '你好呀' },
        ])).toBe('');
    });

    it('空列表和空白用戶消息都不進入重試', () => {
        expect(getPendingReplyText([])).toBe('');
        expect(getPendingReplyText([{ role: 'user', content: '   ' }])).toBe('');
    });
});
