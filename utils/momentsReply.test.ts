import { describe, expect, it } from 'vitest';
import { buildAuthorReplyPrompt, cleanMomentReply, shouldAuthorReply } from './momentsReply';

describe('作者回覆留言', () => {
    it('提示詞帶上貼文、照片數、其他留言和用戶這則', () => {
        const prompt = buildAuthorReplyPrompt({
            authorName: '小雨', userName: '小安',
            post: { content: '今天去海邊', images: ['a', 'b'] },
            thread: '房東: 曬黑了吧', userComment: '好好玩的樣子',
        });
        expect(prompt).toContain('（配了 2 張照片）');
        expect(prompt).toContain('「今天去海邊」');
        expect(prompt).toContain('房東: 曬黑了吧');
        expect(prompt).toContain('小安剛剛在底下留言：「好好玩的樣子」');
    });

    it('用戶是回覆別人的：寫出回覆誰；沒有別的留言時說明', () => {
        const prompt = buildAuthorReplyPrompt({
            authorName: '小雨', userName: '小安', post: { content: '', images: ['a'] },
            thread: '', userComment: '哈哈', replyingToName: '房東',
        });
        expect(prompt).toContain('小安剛剛回覆了房東：「哈哈」');
        expect(prompt).toContain('（還沒有別人留言）');
        expect(prompt).toContain('（只有照片）');
    });

    it('輸出收尾：去名字前綴、引號、換行', () => {
        expect(cleanMomentReply('小雨：「對呀超好玩」', '小雨')).toBe('對呀超好玩');
        expect(cleanMomentReply('我: 下次帶你去\n\n好不好', '小雨')).toBe('下次帶你去 好不好');
    });

    it('只有用戶在角色貼文底下留言才觸發', () => {
        expect(shouldAuthorReply({ author: { kind: 'character', id: 'a', name: 'a' } }, { actor: { kind: 'user', id: 'user', name: '我' } })).toBe(true);
        expect(shouldAuthorReply({ author: { kind: 'user', id: 'user', name: '我' } }, { actor: { kind: 'user', id: 'user', name: '我' } })).toBe(false);
        expect(shouldAuthorReply({ author: { kind: 'character', id: 'a', name: 'a' } }, { actor: { kind: 'character', id: 'b', name: 'b' } })).toBe(false);
    });
});
