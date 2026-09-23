import { describe, it, expect } from 'vitest';
import { normalizeMessageContent } from './messageFormat';
import { ChatPrompts } from './chatPrompts';

// 鎖住「筆友會歷史章節轉發到聊天后，角色在上下文裡讀得到書」這條鏈路。
//
// novel_card 的 content 只是佔位（[筆友會小說]《書名》…），真正的章節歸檔在
// metadata.novel 裡。上下文 / 歸檔 / palace 都靠 normalizeMessageContent 把它
// 翻成完整文本——漏翻的話角色只看到佔位符，等於沒轉發。
// 另外釘住共創者 / 非共創者兩種視角的措辭：共創者要知道"這書有你一份"，
// 旁觀者不能被誘導成"我也寫過"。

const novelMeta = {
    novel: {
        bookTitle: '霧中燈塔',
        subtitle: '第一卷',
        bookSummary: '一座只在霧天出現的燈塔。',
        userName: '我',
        collaboratorNames: ['小筆友', '路人乙'],
        chapters: [
            { index: 1, summary: '守塔人撿到了一封沒有署名的信。' },
            { index: 3, summary: '信的筆跡和守塔人自己的一模一樣。' },
        ],
        count: 2,
    },
};

const baseMsg = {
    id: 1,
    charId: 'c1',
    role: 'user',
    type: 'novel_card',
    content: '[筆友會小說]《霧中燈塔》2 章歸檔',
    timestamp: Date.now(),
    metadata: novelMeta,
} as any;

describe('normalizeMessageContent novel_card 脫水', () => {
    it('共創者視角: 帶書名 + 全部章節總結 + "你是執筆人之一"', () => {
        const text = normalizeMessageContent(baseMsg, '小筆友', '我');
        expect(text).toContain('《霧中燈塔》');
        expect(text).toContain('執筆人之一');
        expect(text).toContain('守塔人撿到了一封沒有署名的信');
        expect(text).toContain('第3章總結');
        expect(text).toContain('一座只在霧天出現的燈塔');
        // 其他共創者也要出現（"還有路人乙"），別把合著者寫丟
        expect(text).toContain('路人乙');
    });

    it('非共創者視角: 明確"沒有參與創作", 不冒認執筆', () => {
        const text = normalizeMessageContent(baseMsg, '圈外角色', '我');
        expect(text).toContain('《霧中燈塔》');
        expect(text).toContain('沒有參與創作');
        expect(text).not.toContain('執筆人之一');
        // 章節內容照樣可讀——分享的意義就是讓 ta 讀到
        expect(text).toContain('信的筆跡和守塔人自己的一模一樣');
    });

    it('metadata 缺失時兜底為佔位, 不拋錯', () => {
        const broken = { ...baseMsg, metadata: {} };
        expect(normalizeMessageContent(broken, '小筆友', '我')).toBe('[筆友會小說章節]');
    });
});

describe('buildMessageHistory 私聊上下文裡 novel_card 完整可讀', () => {
    it('角色上下文裡帶出章節歸檔全文, 不是光禿禿的佔位 (退化即掛)', () => {
        const char = { id: 'c1', name: '小筆友' } as any;
        const userProfile = { name: '我' } as any;
        const history = [{ ...baseMsg, timestamp: Date.now() - 60_000 }];
        const { apiMessages } = ChatPrompts.buildMessageHistory(history, 10, char, userProfile, []);
        const userMsg = apiMessages.find((m: any) => m.role === 'user');
        const content = userMsg!.content as string;
        expect(content).toContain('筆友會');
        expect(content).toContain('守塔人撿到了一封沒有署名的信');
        expect(content).toContain('執筆人之一');
    });
});
