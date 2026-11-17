import { describe, expect, it } from 'vitest';
import { extractTodoDirectives, TODO_TAG_RE, todoTitleMatches } from './todoTagParse';

// 待辦標籤的容錯解析（plans/calendar.md 第 2 節）

describe('extractTodoDirectives', () => {
    it('標準寫法：加一條（含截止日）、勾掉一條，正文剝乾淨', () => {
        const r = extractTodoDirectives('好，我記下來。\n[[TODO|買貓砂|2026-11-20]]\n還有，\n[[TODO_DONE|交報告]]\n搞定了。');
        expect(r.directives).toEqual([{ kind: 'add', title: '買貓砂', deadline: '2026-11-20' }, { kind: 'done', title: '交報告' }]);
        expect(r.cleanedText).toBe('好，我記下來。\n\n還有，\n\n搞定了。');
        expect(r.malformedCount).toBe(0);
    });

    it('截止日可省；日期寫法鬆（單位數、斜線）也認；不是日期的第二段併進標題', () => {
        expect(extractTodoDirectives('[[TODO|回媽媽電話]]').directives).toEqual([{ kind: 'add', title: '回媽媽電話' }]);
        expect(extractTodoDirectives('[[TODO|回電話|2026/1/5]]').directives).toEqual([{ kind: 'add', title: '回電話', deadline: '2026-01-05' }]);
        expect(extractTodoDirectives('[[TODO|去超市|買牛奶和蛋]]').directives).toEqual([{ kind: 'add', title: '去超市 買牛奶和蛋' }]);
        expect(extractTodoDirectives('[[TODO|回電話|2026-13-40]]').directives).toEqual([{ kind: 'add', title: '回電話 2026-13-40' }]);
    });

    it('容錯：全角豎線、冒號、ACTION: 前綴、中文別名、大小寫', () => {
        expect(extractTodoDirectives('[[待辦｜洗衣服｜2026-11-18]]').directives).toEqual([{ kind: 'add', title: '洗衣服', deadline: '2026-11-18' }]);
        expect(extractTodoDirectives('[[ACTION:TODO: 洗衣服]]').directives).toEqual([{ kind: 'add', title: '洗衣服' }]);
        expect(extractTodoDirectives('[[做完待辦|洗衣服]]').directives).toEqual([{ kind: 'done', title: '洗衣服' }]);
        expect(extractTodoDirectives('[[待办完成：洗衣服]]').directives).toEqual([{ kind: 'done', title: '洗衣服' }]);
        expect(extractTodoDirectives('[[todo_done|洗衣服]]').directives).toEqual([{ kind: 'done', title: '洗衣服' }]);
    });

    it('沒標題的算壞、剝掉不落；別的標籤不動', () => {
        const r = extractTodoDirectives('[[TODO]] 嗯 [[TODO|]] [[ACTION:GIFT|x]]');
        expect(r.directives).toEqual([]);
        expect(r.malformedCount).toBe(2);
        expect(r.cleanedText).toBe('嗯  [[ACTION:GIFT|x]]');
    });

    it('TODO_TAG_RE 給 worker 直通用：整段標籤、全域', () => {
        const text = 'a [[TODO|x]] b [[TODO_DONE|y]] c';
        expect(text.match(TODO_TAG_RE)).toEqual(['[[TODO|x]]', '[[TODO_DONE|y]]']);
    });
});

describe('todoTitleMatches', () => {
    it('去標點空白相等、或一邊包含另一邊', () => {
        expect(todoTitleMatches('買貓砂', '買貓砂。')).toBe(true);
        expect(todoTitleMatches('買貓砂和罐頭', '買貓砂')).toBe(true);
        expect(todoTitleMatches('Call mom', 'call MOM!')).toBe(true);
        expect(todoTitleMatches('買貓砂', '交報告')).toBe(false);
        expect(todoTitleMatches('', '交報告')).toBe(false);
    });
});
