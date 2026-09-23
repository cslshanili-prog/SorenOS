import { describe, it, expect } from 'vitest';
import { ChatPrompts } from './chatPrompts';
import { cleanApiMessages } from './chatRequestPayload';

// 鎖住「翻譯模式下引用回覆, 角色只看到引用、看不到用戶實際回覆」的修復。
//
// 鏈路: 雙語 char 消息存儲為 `原文\n%%BILINGUAL%%\n譯文`; 用戶引用它時 replyTo.content
// 是完整雙語串。buildMessageHistory 把引用拼成
//   [用戶引用了你之前說的「<摘要60字>」，並回復了 ↓]\n<用戶回覆>
// 修復前摘要原樣截取 → %%BILINGUAL%% 混進引用頭 → cleanApiMessages 在標記處整條截斷
// → 「並回復了 ↓」和用戶回覆全被吃掉, 模型只看到半截引用頭。
// 修復後摘要先剝雙語標記、只取原文側, 截斷不再波及用戶回覆。

const char = { id: 'c1', name: '小角色' } as any;
const userProfile = { name: '我' } as any;

const BI_CONTENT = 'こんにちは、元気？\n%%BILINGUAL%%\n你好，最近好嗎？';
const USER_REPLY = '我的實際回覆內容，不能被吞掉';

const t0 = Date.now() - 60_000;
const makeHistory = () => ([
    { id: 1, charId: 'c1', role: 'assistant', type: 'text', content: BI_CONTENT, timestamp: t0 },
    {
        id: 2, charId: 'c1', role: 'user', type: 'text', content: USER_REPLY, timestamp: t0 + 1000,
        replyTo: { id: 1, content: BI_CONTENT, name: '小角色' },
    },
] as any[]);

describe('buildMessageHistory 引用雙語消息', () => {
    it('引用摘要只取原文側, 不把 %%BILINGUAL%% 混進引用頭', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(makeHistory(), 10, char, userProfile, []);
        const userMsg = apiMessages.find((m: any) => m.role === 'user');
        expect(userMsg).toBeTruthy();
        const content = userMsg!.content as string;
        expect(content).toContain('こんにちは、元気？');
        expect(content).toContain(USER_REPLY);
        expect(content.toLowerCase()).not.toContain('%%bilingual%%');
    });

    it('引用頭 + 用戶回覆經 cleanApiMessages 後完整保留 (修復前回復被截掉)', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(makeHistory(), 10, char, userProfile, []);
        const cleaned = cleanApiMessages(apiMessages);
        const userMsg = cleaned.find((m: any) => m.role === 'user');
        const content = userMsg!.content as string;
        expect(content).toContain('引用了');
        expect(content).toContain(USER_REPLY);
    });

    it('雙語 assistant 消息本體仍在標記處截斷只留原文 (既有行為不迴歸)', () => {
        const { apiMessages } = ChatPrompts.buildMessageHistory(makeHistory(), 10, char, userProfile, []);
        const cleaned = cleanApiMessages(apiMessages);
        const aiMsg = cleaned.find((m: any) => m.role === 'assistant');
        const content = aiMsg!.content as string;
        expect(content).toContain('こんにちは、元気？');
        expect(content).not.toContain('你好，最近好嗎？');
    });

    it('引用內容是 <翻譯> XML 形態時也剝乾淨、只留原文', () => {
        const xmlBi = '<翻譯>\n<原文>おはよう</原文>\n<譯文>早上好</譯文>\n</翻譯>';
        const history = [
            { id: 1, charId: 'c1', role: 'assistant', type: 'text', content: xmlBi, timestamp: t0 },
            {
                id: 2, charId: 'c1', role: 'user', type: 'text', content: USER_REPLY, timestamp: t0 + 1000,
                replyTo: { id: 1, content: xmlBi, name: '小角色' },
            },
        ] as any[];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, []);
        const userMsg = apiMessages.find((m: any) => m.role === 'user');
        const content = userMsg!.content as string;
        expect(content).toContain('おはよう');
        expect(content).toContain(USER_REPLY);
        expect(content).not.toContain('<翻譯>');
        expect(content).not.toContain('<譯文>');
    });
});
