import { describe, it, expect } from 'vitest';
import { sanitizeQuerySourceMessages } from './querySanitizer';
import type { Message } from '../../types';

// 這組測試守護「檢索 query 源必須是乾淨文本」這條契約：
// 圖片消息的 content 是整段 base64 data URI（幾萬字符），一旦漏進
// spike / rerank / context query，會把 Embedding 批量請求頂爆
// （硅基流動 400 code 20015）。入庫管線早有同口徑過濾，檢索這層不能再漏。

const msg = (partial: Partial<Message>): Message => ({
    id: 1,
    charId: 'c1',
    role: 'user',
    type: 'text',
    content: '',
    timestamp: 1000,
    ...partial,
} as Message);

describe('sanitizeQuerySourceMessages', () => {
    it('純文本消息原樣保留（同一對象引用，不做無謂拷貝）', () => {
        const m = msg({ content: '今天我要回家看家人啦' });
        const out = sanitizeQuerySourceMessages([m]);
        expect(out).toHaveLength(1);
        expect(out[0]).toBe(m);
    });

    it('圖片消息（content = base64 data URI）整條丟棄', () => {
        const image = msg({ type: 'image', content: `data:image/jpeg;base64,${'A'.repeat(50000)}` });
        const out = sanitizeQuerySourceMessages([msg({ content: '你看這張圖' }), image]);
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('你看這張圖');
    });

    it('表情包 / 無轉寫的純音頻資源整條丟棄', () => {
        const out = sanitizeQuerySourceMessages([
            msg({ type: 'emoji', content: 'https://img.host/sticker.png' }),
            msg({ type: 'voice', content: 'blob:xxx' }),
            msg({ content: '晚安' }),
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('晚安');
    });

    it('有配套文字的語音按轉寫內容參與記憶檢索', () => {
        const out = sanitizeQuerySourceMessages([
            msg({ type: 'voice', content: '今天下班路上看見了一隻很像你的貓' }),
            msg({
                type: 'voice',
                content: 'blob:voice-audio',
                metadata: { transcript: '別忘了明天一起去看電影' },
            }),
        ]);

        expect(out).toHaveLength(2);
        expect(out[0].content).toContain('今天下班路上看見了一隻很像你的貓');
        expect(out[1].content).toContain('別忘了明天一起去看電影');
        expect(out.every(item => item.content.startsWith('[語音轉寫]'))).toBe(true);
    });

    it('文本里粘貼的 data URI 被剝掉，其餘文字保留', () => {
        const m = msg({ content: `看看這個 data:image/png;base64,${'B'.repeat(8000)} 好看嗎` });
        const out = sanitizeQuerySourceMessages([m]);
        expect(out).toHaveLength(1);
        expect(out[0].content).not.toContain('base64');
        expect(out[0].content).toContain('看看這個');
        expect(out[0].content).toContain('好看嗎');
        expect(out[0].content.length).toBeLessThan(50);
    });

    it('文本內容剝完 data URI 後為空 → 整條丟棄', () => {
        const m = msg({ content: 'data:image/webp;base64,CCCC' });
        expect(sanitizeQuerySourceMessages([m])).toHaveLength(0);
    });

    it('卡片類消息翻成可讀文本參與檢索（不再是佔位符/JSON）', () => {
        const music = msg({
            type: 'music_card',
            role: 'assistant',
            content: '[音樂卡片]',
            metadata: { song: { name: '海底', artists: '一支榴蓮' }, intent: 'join' },
        });
        const out = sanitizeQuerySourceMessages([music], '阿汐', '小魚');
        expect(out).toHaveLength(1);
        expect(out[0].content).toContain('海底');
        expect(out[0].content).toContain('阿汐');
    });

    it('正文為空但 metadata 有內容的卡片仍參與統計與記憶上下文', () => {
        const xhs = msg({
            type: 'xhs_card',
            content: '',
            metadata: {
                xhsNote: {
                    title: '今天遇到一隻很親人的小貓',
                    desc: '它一路跟著我走到了地鐵口。',
                    author: '路邊觀察員',
                },
            },
        });
        const out = sanitizeQuerySourceMessages([xhs], '阿澄', '小魚');
        expect(out).toHaveLength(1);
        expect(out[0].content).toContain('今天遇到一隻很親人的小貓');
        expect(out[0].content).toContain('它一路跟著我走到了地鐵口');
    });

    it('空消息丟棄；沒有 type 字段的合成消息按文本處理', () => {
        const out = sanitizeQuerySourceMessages([
            msg({ content: '   ' }),
            { role: 'user', content: '合成消息' } as any,
        ]);
        expect(out).toHaveLength(1);
        expect(out[0].content).toBe('合成消息');
    });
});
