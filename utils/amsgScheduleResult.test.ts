import { describe, expect, it } from 'vitest';
import { buildScheduleChangeResult, parseScheduleChangeResult, SCHEDULE_CHANGE_RESULT_KIND } from './amsgScheduleResult';

// 這條結果是 worker 寫、客戶端讀的跨端形狀。形狀對不上時必須返回 null——客戶端據此
// 銷帳丟棄，而不是拿著半份數據去改用戶的日程表。
describe('schedule-change 結果的往返', () => {
    it('組出來的結果讀得回去', () => {
        const built = buildScheduleChangeResult({
            charId: 'char-1',
            spokenAt: 1755600000000,
            directives: [{ startTime: '22:00', activity: '陪你聊天' }],
        });
        expect(built.resultKind).toBe(SCHEDULE_CHANGE_RESULT_KIND);
        expect(parseScheduleChangeResult(built)).toEqual(built);
    });

    it.each([
        ['不是對象', 'nope'],
        ['resultKind 對不上', { resultKind: 'other', v: 1, charId: 'c', spokenAt: 1, directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['版本對不上', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 2, charId: 'c', spokenAt: 1, directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['沒有 charId', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 1, spokenAt: 1, directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['spokenAt 不是數字', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 1, charId: 'c', spokenAt: '昨晚', directives: [{ startTime: '22:00', activity: 'x' }] }],
        ['一條有效指令都沒有', { resultKind: SCHEDULE_CHANGE_RESULT_KIND, v: 1, charId: 'c', spokenAt: 1, directives: [{ startTime: '', activity: '' }] }],
    ])('%s → null', (_label, raw) => {
        expect(parseScheduleChangeResult(raw)).toBeNull();
    });

    it('混著壞條目時只留下能用的那些', () => {
        const parsed = parseScheduleChangeResult({
            resultKind: SCHEDULE_CHANGE_RESULT_KIND,
            v: 1,
            charId: 'char-1',
            spokenAt: 1755600000000,
            directives: [
                { startTime: '22:00', activity: '陪你聊天' },
                { startTime: '23:00' },
                null,
                { startTime: '  ', activity: '空的' },
            ],
        });
        expect(parsed?.directives).toEqual([{ startTime: '22:00', activity: '陪你聊天' }]);
    });
});
