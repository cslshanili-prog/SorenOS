import { describe, expect, it } from 'vitest';
import type { CalendarEvent, Participant } from '../types';
import {
    buildAgreementsBlock, buildOutlineBlock, buildSchedulePromptBlock, buildTodosBlock, buildWeekOutlinePrompt, eventsForDay, openTodosOf, parseWeekOutline,
    resolveDoneTodos, resolveSlotPeople, resolveSlotTodo, toScheduleSlot, weekdayOf,
} from './scheduleGenParts';

// 日程生成多帶的段與落庫對回（plans/calendar.md 第 3 批）

const me: Participant = { kind: 'persona', id: '__real__' };
const him: Participant = { kind: 'char', id: 'c1' };
const her: Participant = { kind: 'npc', id: 'n1' };
const people = [{ participant: me, name: '小林' }, { participant: him, name: '宋時聿' }, { participant: her, name: '阿姨' }];
const nameOf = (p: Participant) => people.find(x => x.participant.kind === p.kind && x.participant.id === p.id)?.name || '';
let n = 0;
const ev = (f: Partial<CalendarEvent> & Pick<CalendarEvent, 'title' | 'start'>): CalendarEvent =>
    ({ id: `e${++n}`, owner: him, kind: 'event', source: 'user', createdAt: 0, updatedAt: 0, ...f });

describe('提示詞段', () => {
    it('當天的約定：有份的也算、寫跟誰、紀念日標出來；沒有就空', () => {
        const events = [
            ev({ title: '看展', start: '2026-11-20T14:00', end: '2026-11-20T17:00', location: '北美館', owner: me, participants: [him] }),
            ev({ title: '生日', start: '2020-11-20', kind: 'anniversary', repeat: 'yearly', allDay: true, owner: me, participants: [him] }),
            ev({ title: '別天', start: '2026-11-21T10:00' }),
            ev({ title: '待辦不算', start: '2026-11-20', kind: 'todo', allDay: true }),
        ];
        expect(eventsForDay(events, him, '2026-11-20').map(e => e.title)).toEqual(['看展', '生日']);
        const block = buildAgreementsBlock(events, him, '2026-11-20', nameOf);
        expect(block).toContain('- 14:00–17:00 看展（北美館），跟 小林 一起【約好的事】');
        expect(block).toContain('- 全天 生日，跟 小林 一起【紀念日】');
        expect(buildAgreementsBlock(events, him, '2026-11-25', nameOf)).toBe('');
    });

    it('待辦段：只列自己沒做完的、截止近的在前、過期標出來；超過上限截掉', () => {
        const events = [
            ev({ title: '交報告', start: '2026-11-18', kind: 'todo', allDay: true }),
            ev({ title: '買貓砂', start: '2026-11-22', kind: 'todo', allDay: true }),
            ev({ title: '做完了', start: '2026-11-10', kind: 'todo', allDay: true, done: true }),
            ev({ title: '別人的', start: '2026-11-19', kind: 'todo', allDay: true, owner: me }),
        ];
        expect(openTodosOf(events, him).map(e => e.title)).toEqual(['交報告', '買貓砂']);
        const block = buildTodosBlock(events, him, '2026-11-20');
        expect(block).toContain('- 交報告（截止 2026-11-18，已經過期）');
        expect(block).toContain('- 買貓砂（截止 2026-11-22）');
        expect(block).not.toContain('別人的');
        expect(buildTodosBlock(events, him, '2026-11-20', 1)).not.toContain('買貓砂');
    });

    it('行程提示詞與大綱段：空的不給', () => {
        expect(buildSchedulePromptBlock('  ')).toBe('');
        expect(buildSchedulePromptBlock('週一到週五 9 點上班')).toContain('週一到週五 9 點上班');
        expect(buildOutlineBlock(undefined)).toBe('');
        expect(buildOutlineBlock('實驗室整天')).toContain('實驗室整天');
    });
});

describe('落庫對回', () => {
    it('with 的名字對回 id；對不上的只留文字；自己不算', () => {
        expect(resolveSlotPeople('小林、阿姨', people, him)).toEqual({ participants: [me, her], with: '小林、阿姨' });
        expect(resolveSlotPeople('小林 和 老闆', people, him)).toEqual({ participants: [me], with: '小林、老闆' });
        expect(resolveSlotPeople('宋時聿', people, him)).toEqual({ with: '宋時聿' });
        expect(resolveSlotPeople('', people, him)).toEqual({});
    });

    it('todo 標題模糊對回 todoId；doneTodos 對回要勾的那幾條', () => {
        const todos = [ev({ title: '買貓砂', start: '2026-11-22', kind: 'todo', allDay: true }), ev({ title: '交報告', start: '2026-11-18', kind: 'todo', allDay: true })];
        expect(resolveSlotTodo('貓砂', todos)).toBe(todos[0].id);
        expect(resolveSlotTodo('洗衣服', todos)).toBeUndefined();
        expect(resolveDoneTodos(['交報告。', '不存在'], todos).map(e => e.id)).toEqual([todos[1].id]);
        expect(resolveDoneTodos('不是陣列', todos)).toEqual([]);
    });

    it('toScheduleSlot：多欄位都對回；沒 activity 的丟掉；with 給陣列也認', () => {
        const todos = [ev({ title: '買貓砂', start: '2026-11-22', kind: 'todo', allDay: true })];
        const slot = toScheduleSlot({ startTime: '15:00', activity: '去超市', description: '順便', emoji: '🛒', location: '全聯', with: ['小林'], todo: '買貓砂' }, people, him, todos);
        expect(slot).toEqual({ startTime: '15:00', activity: '去超市', description: '順便', emoji: '🛒', location: '全聯', innerThought: undefined, participants: [me], with: '小林', todoId: todos[0].id });
        expect(toScheduleSlot({ startTime: '15:00' }, people, him, todos)).toBeNull();
        expect(toScheduleSlot({ activity: '發呆' }, people, him, todos)).toMatchObject({ startTime: '00:00', activity: '發呆' });
    });
});

describe('一週', () => {
    it('weekdayOf 與大綱提示詞', () => {
        expect(weekdayOf('2026-11-17')).toBe('二');
        const p = buildWeekOutlinePrompt('宋時聿', ['2026-11-17', '2026-11-18'], '', '', '', '');
        expect(p).toContain('2026-11-17（週二）、2026-11-18（週三）');
        expect(p).toContain('"todos"');
    });

    it('parseWeekOutline：照日期對、對不上照順序、全空回 null、todos 清乾淨', () => {
        const days = ['2026-11-17', '2026-11-18'];
        expect(parseWeekOutline({ days: [{ date: '2026-11-18', outline: '週三' }, { date: '2026-11-17', outline: '週二' }], todos: ['買貓砂', '', 3] }, days))
            .toEqual({ days: [{ date: '2026-11-17', outline: '週二' }, { date: '2026-11-18', outline: '週三' }], todos: ['買貓砂'] });
        expect(parseWeekOutline({ days: [{ outline: 'a' }, { outline: 'b' }] }, days)?.days.map(d => d.outline)).toEqual(['a', 'b']);
        expect(parseWeekOutline({ days: [] }, days)).toBeNull();
        expect(parseWeekOutline(null, days)).toBeNull();
    });
});
