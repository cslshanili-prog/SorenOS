import { describe, expect, it, vi } from 'vitest';
import { acquireChatReply, isChatReplyActive, subscribeChatReplies } from './chatReplyLock';
import { withChatContinuation } from './chatContinuation';

describe('手動回覆邊界', () => {
    it('同一幀只接納一次；取消訂閱/重新進入聊天不解除後台請求佔位', () => {
        const listener = vi.fn();
        const unsubscribe = subscribeChatReplies(listener);
        const release = acquireChatReply('a')!;
        expect(acquireChatReply('a')).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
        expect(isChatReplyActive('a')).toBe(true);
        expect(acquireChatReply('a')).toBeNull();
        const releaseB = acquireChatReply('b')!;
        releaseB();
        expect(isChatReplyActive('a')).toBe(true);
        release();
        const releaseNext = acquireChatReply('a')!;
        release(); // 舊請求的重複清理不能誤解鎖下一輪
        expect(isChatReplyActive('a')).toBe(true);
        releaseNext();
        expect(isChatReplyActive('a')).toBe(false);
    });

    it('助手已答完時追加一次續說操作，保留原歷史及消息角色', () => {
        const history = [
            { role: 'user', content: '今天怎麼樣' },
            { role: 'assistant', content: '很好。' },
            { role: 'system', content: '實時上下文' },
        ];
        const request = withChatContinuation(history, ' 小雨 ');
        expect(history).toHaveLength(3);
        expect(request.slice(0, 3)).toEqual(history);
        expect(request[3].role).toBe('user');
        expect(request[3].content).toBe('[小雨還想聽你接著說。順著剛才的話自然繼續，只寫你自己的話，說完就等小雨回應。]');
        expect(request[3].content).not.toContain('點擊');
        expect(request[3].content).not.toContain('用戶');
        expect(withChatContinuation(history, ' ')[3].content).toContain('對方還想聽你接著說');
        expect(withChatContinuation(request)).toBe(request);
    });

    it('新用戶消息、圖片及空歷史不添加續說操作', () => {
        for (const history of [[], [{ role: 'user', content: '在嗎' }], [
            { role: 'assistant', content: '你好' },
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'test.png' } }] },
        ]]) expect(withChatContinuation(history)).toBe(history);
    });
});
