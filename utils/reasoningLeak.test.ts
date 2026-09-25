import { describe, expect, it } from 'vitest';
import { stripLeakedReasoning } from './reasoningLeak';

const clean = (s: string) => stripLeakedReasoning(s).content;

describe('群聊思考過程外洩', () => {
    it('有標籤的思考區塊整塊剝掉（含沒閉合、只剩結束標籤）', () => {
        expect(clean('<thinking>\n用戶剛才說了晚餐的事，我應該接話\n</thinking>\n哇你們吃火鍋不叫我')).toBe('哇你們吃火鍋不叫我');
        expect(clean('<think>嗯…</think>哈哈哈')).toBe('哈哈哈');
        expect(clean('好啊\n<thinking>接下來我要')).toBe('好啊');
        expect(clean('我得先看看群裡在聊什麼</thinking>\n誰要喝奶茶')).toBe('誰要喝奶茶');
    });

    it('開頭沒標籤的分析也剝：讓我看看現在的狀況、系統口吻、英文', () => {
        expect(clean('讓我看看現在的狀況…大家在聊週末要去哪\n\n我投海邊一票！')).toBe('我投海邊一票！');
        expect(clean('好的，讓我分析一下目前的情況。\n用戶剛剛提到加班，作為角色我應該關心\n又加班？？')).toBe('又加班？？');
        expect(clean('Let me think about how Sully would respond.\n笨蛋，早點睡')).toBe('笨蛋，早點睡');
        expect(clean('（思考：她好像不開心）\n怎麼了')).toBe('怎麼了');
        expect(clean('**分析**\n輪到我了\n嗯嗯')).toBe('嗯嗯');
    });

    it('整則都是分析就剩空字串（這位成員這輪等於沒說話）', () => {
        expect(clean('<thinking>')).toBe('');
        expect(clean('讓我想想現在的情況該怎麼回')).toBe('');
    });

    it('正常台詞不動，包括台詞裡的「讓我看看」、網路用語', () => {
        for (const line of ['讓我看看你今天穿什麼', '你人設崩了吧哈哈', '[[SEND_EMOJI: 貓貓]]', '好啦\n讓我想想晚餐吃什麼']) {
            expect(clean(line)).toBe(line);
            expect(stripLeakedReasoning(line).stripped).toBe(false);
        }
        expect(clean('哈哈\n（思考：他真可愛）')).toBe('哈哈\n（思考：他真可愛）');
    });
});

import { buildGroupHistoryBlock } from './groupChat/prompts';
import { parseDirectorActions } from './groupChat/parse';

describe('不再傳染給下一位', () => {
    it('組群聊記錄時，舊的外洩思考被剝掉、整則是思考的那行拿掉', () => {
        const chars = [{ id: 'a', name: '小夏' }, { id: 'b', name: 'Sully' }];
        const msgs = [
            { id: 1, charId: 'a', role: 'assistant', type: 'text', content: '<thinking>', timestamp: 1 },
            { id: 2, charId: 'a', role: 'assistant', type: 'text', content: '讓我看看現在的狀況，大家在聊晚餐\n吃火鍋！', timestamp: 2 },
            { id: 3, charId: 'b', role: 'assistant', type: 'text', content: '好', timestamp: 3 },
        ] as any;
        const text = buildGroupHistoryBlock(msgs, chars, [], '我').text;
        expect(text).not.toContain('thinking');
        expect(text).not.toContain('讓我看看現在的狀況');
        expect(text).toContain('小夏: 吃火鍋！');
        expect(text).toContain('Sully: 好');
    });

    it('導演模式：JSON 前面的思考區塊（裡面有方括號）不會害解析失敗', () => {
        const raw = '<think>先想想 [誰] 該說話</think>\n[{"charId":"a","content":"早安"}]';
        expect(parseDirectorActions(raw)).toEqual([{ charId: 'a', content: '早安' }]);
    });
});
