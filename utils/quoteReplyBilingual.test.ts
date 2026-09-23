/**
 * 引用回覆 × 雙語角色 迴歸測試
 *
 * Bug 背景（Discord「老師們遇到了關於引用的bug」）：
 * 開翻譯的外語/粵語角色消息落庫為「原文\n%%BILINGUAL%%\n譯文」。用戶引用這類
 * 消息回覆時，replyTo 快照原樣帶著 %%BILINGUAL%% 標記進了拼好的 user 消息，
 * cleanApiMessages 剝雙語時從標記處把整條消息砍掉 —— 用戶的新回覆整段消失，
 * 模型只看到半截引用（即「char 只看到引用、看不到回覆」）。
 *
 * 修復落點在 chatPrompts 的引用頭構造（源頭不讓標記混入 user 消息），
 * 這裡鎖端到端效果 + cleanApiMessages 對 assistant 的既有截斷行為。
 */
import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { cleanApiMessages } from './chatRequestPayload';

const BILINGUAL_CHAR_MSG = 'Bonjour, ça va ?\n%%BILINGUAL%%\n你好，最近怎麼樣？';
const USER_REPLY = '我想問你昨天說的那件事';

function buildHistoryWithQuote() {
    const char: any = { id: 'c1', name: '露西', timeAwarenessEnabled: false };
    const userProfile: any = { name: '阿初' };
    const messages: any[] = [
        {
            id: 1, charId: 'c1', role: 'assistant', type: 'text',
            content: BILINGUAL_CHAR_MSG, timestamp: 1750000000000,
        },
        {
            id: 2, charId: 'c1', role: 'user', type: 'text',
            content: USER_REPLY, timestamp: 1750000060000,
            replyTo: { id: 1, content: BILINGUAL_CHAR_MSG, name: '露西' },
        },
    ];
    return ChatPrompts.buildMessageHistory(messages, 10, char, userProfile, []);
}

describe('用戶引用雙語角色消息', () => {
    it('拼出的引用框只取原文側，不夾帶 %%BILINGUAL%% 標記', () => {
        const { apiMessages } = buildHistoryWithQuote();
        const userMsg = apiMessages[1];
        expect(userMsg.role).toBe('user');
        expect(userMsg.content).not.toMatch(/%%bilingual%%/i);
        expect(userMsg.content).toContain('Bonjour, ça va ?');
        expect(userMsg.content).toContain(USER_REPLY);
    });

    it('經過 cleanApiMessages 後用戶的回覆仍然在（端到端）', () => {
        const { apiMessages } = buildHistoryWithQuote();
        const cleaned = cleanApiMessages(apiMessages);
        expect(cleaned[1].content).toContain('並回復了');
        expect(cleaned[1].content).toContain(USER_REPLY);
    });
});

describe('cleanApiMessages 雙語剝離', () => {
    it('assistant 雙語消息只保留原文側（原有行為不迴歸）', () => {
        const cleaned = cleanApiMessages([
            { role: 'assistant', content: BILINGUAL_CHAR_MSG },
        ]);
        expect(cleaned[0].content).toBe('Bonjour, ça va ?');
    });
});
