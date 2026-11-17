import { describe, expect, it } from 'vitest';
import { buildCharTodoInjection, TODO_TAG_GUIDE } from './calendarInjection';

// 角色待辦那段提示詞（plans/calendar.md 第 5 節）

describe('buildCharTodoInjection', () => {
    it('沒待辦也給標籤教學', () => {
        const s = buildCharTodoInjection([], '2026-11-17');
        expect(s).toContain('【你的待辦】');
        expect(s).toContain('目前沒有沒做完的待辦');
        expect(s).toContain(TODO_TAG_GUIDE);
    });

    it('截止日寫成今天／明天／過期幾天；對方幫記的標出來；超過上限只說還有幾條', () => {
        const s = buildCharTodoInjection([
            { title: '交報告', deadline: '2026-11-17', fromChat: true },
            { title: '買貓砂', deadline: '2026-11-18', fromChat: false },
            { title: '回電話', deadline: '2026-11-15', fromChat: true },
            { title: '沒日期', fromChat: true },
        ], '2026-11-17', 3);
        expect(s).toContain('- 交報告（今天）');
        expect(s).toContain('- 買貓砂（明天）（對方幫你記的）');
        expect(s).toContain('- 回電話（2 天前就該做了）');
        expect(s).not.toContain('沒日期');
        expect(s).toContain('還有 1 條沒列');
    });
});
