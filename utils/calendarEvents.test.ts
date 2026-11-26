import { beforeEach, describe, expect, it } from 'vitest';
import type { Anniversary, CalendarEvent, Task } from '../types';
import {
    anniversaryView, charParticipant, eventOnDay, eventsInvolving, eventsOn, eventTime, findTodoToComplete, legacyToEvents, loadCalendarEvents,
    migrateLegacyCalendar, newEvent, openTodos, ownedBy, personaParticipant, sameParticipant, sortByTime,
} from './calendarEvents';
import { applyTodoDirectives } from './todoTag';
import { DB } from './db';
import { REAL_IDENTITY_PERSONA_ID } from './userPersona';

// 行事曆的約定層（plans/calendar.md 第 2 批）

const me = personaParticipant(undefined);
const him = charParticipant('c1');
const ev = (fields: Partial<CalendarEvent> & Pick<CalendarEvent, 'title' | 'start'>): CalendarEvent =>
    newEvent({ owner: me, kind: 'event', source: 'user', ...fields });

describe('純函數', () => {
    it('personaParticipant 沒給 key 就是真實身份；sameParticipant 比 kind＋id（舊資料的 npc 當同 id 的角色）', () => {
        expect(me).toEqual({ kind: 'persona', id: REAL_IDENTITY_PERSONA_ID });
        expect(sameParticipant(him, charParticipant('c1'))).toBe(true);
        // NPC 搬成配角時 id 照舊：舊事件上的 npc 參與者就是那個角色
        expect(sameParticipant(him, { kind: 'npc', id: 'c1' })).toBe(true);
        expect(sameParticipant(him, { kind: 'npc', id: 'c2' })).toBe(false);
        expect(sameParticipant(him, { kind: 'persona', id: 'c1' })).toBe(false);
        expect(sameParticipant(undefined, him)).toBe(false);
    });

    it('eventOnDay：有時段的看開始那天、跨天事件中間也算、紀念日看每年那次、待辦看截止日', () => {
        expect(eventOnDay(ev({ title: 'a', start: '2026-11-17T19:00' }), '2026-11-17')).toBe(true);
        expect(eventOnDay(ev({ title: 'a', start: '2026-11-17T19:00' }), '2026-11-18')).toBe(false);
        const trip = ev({ title: 'trip', start: '2026-11-17T09:00', end: '2026-11-19T18:00' });
        expect(eventOnDay(trip, '2026-11-18')).toBe(true);
        expect(eventOnDay(trip, '2026-11-20')).toBe(false);
        const anni = ev({ title: 'anni', start: '2020-03-05', kind: 'anniversary', repeat: 'yearly', allDay: true });
        expect(eventOnDay(anni, '2026-03-05')).toBe(true);
        expect(eventOnDay(anni, '2026-03-06')).toBe(false);
        const once = ev({ title: 'once', start: '2020-03-05', kind: 'anniversary', allDay: true });
        expect(eventOnDay(once, '2026-03-05')).toBe(false);
        expect(eventOnDay(once, '2020-03-05')).toBe(true);
        const todo = ev({ title: 't', start: '2026-11-20', kind: 'todo', allDay: true });
        expect(eventsOn([todo], '2026-11-20')).toHaveLength(1);
    });

    it('eventsInvolving 含 owner 和 participants；ownedBy 只看 owner', () => {
        const mine = ev({ title: 'mine', start: '2026-11-17', allDay: true, participants: [him] });
        const his = ev({ title: 'his', start: '2026-11-17', allDay: true, owner: him });
        expect(eventsInvolving([mine, his], him).map(e => e.title)).toEqual(['mine', 'his']);
        expect(ownedBy([mine, his], him).map(e => e.title)).toEqual(['his']);
    });

    it('eventTime 與 sortByTime：全天在前、再照時間', () => {
        const a = ev({ title: 'a', start: '2026-11-17T19:00', end: '2026-11-17T21:00' });
        const b = ev({ title: 'b', start: '2026-11-17T09:00' });
        const c = ev({ title: 'c', start: '2026-11-17', allDay: true });
        expect(eventTime(a)).toBe('19:00');
        expect(eventTime(a, 'end')).toBe('21:00');
        expect(eventTime(c)).toBeUndefined();
        expect(sortByTime([a, b, c]).map(e => e.title)).toEqual(['c', 'b', 'a']);
    });

    it('openTodos 只回沒做完的、截止近的在前；findTodoToComplete 模糊比對、只找 owner 自己的', () => {
        const t1 = ev({ title: '買貓砂', start: '2026-11-20', kind: 'todo', allDay: true, owner: him });
        const t2 = ev({ title: '交報告', start: '2026-11-18', kind: 'todo', allDay: true, owner: him });
        const t3 = ev({ title: '做完了', start: '2026-11-10', kind: 'todo', allDay: true, owner: him, done: true });
        const t4 = ev({ title: '買貓砂', start: '2026-11-10', kind: 'todo', allDay: true });
        expect(openTodos([t1, t2, t3, t4], him).map(e => e.title)).toEqual(['交報告', '買貓砂']);
        expect(openTodos([t1, t2, t3, t4]).length).toBe(3);
        expect(findTodoToComplete([t1, t2, t3, t4], him, '貓砂')?.id).toBe(t1.id);
        expect(findTodoToComplete([t1, t2, t3, t4], him, '洗衣服')).toBeNull();
    });

    it('anniversaryView 轉成舊的 Anniversary 形狀給 utils/anniversary.ts', () => {
        const a = ev({ title: '認識的那天', start: '2024-05-01', kind: 'anniversary', repeat: 'yearly', allDay: true, participants: [him, charParticipant('c2')], charRemembers: true });
        const view = anniversaryView([a, ev({ title: 'x', start: '2026-11-17' })]);
        expect(view).toEqual([{ id: a.id, title: '認識的那天', date: '2024-05-01', charId: 'c1', charIds: ['c1', 'c2'], charRemembers: true, repeatAnnually: true }]);
    });

    it('legacyToEvents：時光契約的待辦進真實身份名下、紀念日帶角色、id 沿用舊的', () => {
        const tasks: Task[] = [{ id: 't1', title: '買菜', isCompleted: true, completedAt: 5, createdAt: 1, deadline: '2026-11-01T10:00' } as Task, { id: 't2', title: '沒日期', isCompleted: false, createdAt: Date.UTC(2026, 10, 3) } as Task];
        const annis: Anniversary[] = [{ id: 'a1', title: '生日', date: '2000-02-29', charId: 'c1', charIds: ['c1', 'c2'], repeatAnnually: true, charRemembers: true, aiThought: '想了很久' } as Anniversary];
        const out = legacyToEvents(tasks, annis, 100);
        expect(out.map(e => e.id)).toEqual(['legacy-task-t1', 'legacy-task-t2', 'legacy-anni-a1']);
        expect(out[0]).toMatchObject({ kind: 'todo', owner: me, start: '2026-11-01', done: true, doneBy: 'user', completedAt: 5, source: 'user' });
        expect(out[1]).toMatchObject({ kind: 'todo', start: '2026-11-03', done: undefined });
        expect(out[2]).toMatchObject({ kind: 'anniversary', start: '2000-02-29', repeat: 'yearly', charRemembers: true, note: '想了很久', participants: [him, charParticipant('c2')] });
    });
});

describe('搬家與落庫（fake-indexeddb）', () => {
    beforeEach(async () => {
        for (const e of await DB.getAllCalendarEvents()) await DB.deleteCalendarEvent(e.id);
        try { localStorage.removeItem('soren_calendar_legacy_migrated_v1'); } catch { /* node 沒有 */ }
    });

    it('migrateLegacyCalendar 把舊表搬進來，重跑不疊', async () => {
        await DB.saveTask({ id: 'old1', title: '舊待辦', isCompleted: false, createdAt: 1 } as Task);
        await DB.saveAnniversary({ id: 'olda', title: '舊紀念日', date: '2021-01-01', charId: 'c1', repeatAnnually: true } as Anniversary);
        expect(await migrateLegacyCalendar()).toBe(2);
        const events = await loadCalendarEvents();
        expect(events.filter(e => e.id.startsWith('legacy-'))).toHaveLength(2);
        await migrateLegacyCalendar();
        expect((await DB.getAllCalendarEvents()).filter(e => e.id.startsWith('legacy-'))).toHaveLength(2);
    });

    it('applyTodoDirectives：角色加一條記 source char、做完記 doneBy ai、對不上進 unmatched', async () => {
        const r1 = await applyTodoDirectives([{ kind: 'add', title: '買貓砂', deadline: '2026-11-20' }], him, 1000);
        expect(r1.added).toHaveLength(1);
        expect(r1.added[0]).toMatchObject({ owner: him, kind: 'todo', title: '買貓砂', start: '2026-11-20', source: 'char', allDay: true });
        const r2 = await applyTodoDirectives([{ kind: 'done', title: '貓砂' }, { kind: 'done', title: '洗衣服' }], him, 2000);
        expect(r2.completed.map(e => e.title)).toEqual(['買貓砂']);
        expect(r2.completed[0]).toMatchObject({ done: true, doneBy: 'ai', completedAt: 2000 });
        expect(r2.unmatched).toEqual(['洗衣服']);
        expect(openTodos(await DB.getAllCalendarEvents(), him)).toHaveLength(0);
    });
});
