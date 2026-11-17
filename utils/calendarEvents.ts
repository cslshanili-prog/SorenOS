/**
 * 行事曆的約定層（plans/calendar.md 第 2、3 節）：你手動加的、約好的事、待辦、紀念日，都是一條 CalendarEvent，
 * 存在 calendar_events 表。角色的一天（DailySchedule）不在這裡，那是生活流。
 *
 * - 誰的：owner（身份卡 personaKey、角色、配角）
 * - 待辦：kind 'todo'，沒有時段只有截止日（start 只看日期）
 * - 紀念日：kind 'anniversary'，全天、repeat 'yearly'；「讓 TA 記住這一天」照舊注入（utils/anniversary.ts）
 * - 時光契約的 tasks／anniversaries 第一次用到時搬進來（migrateLegacyCalendar），舊表留著不讀
 */

import type { Anniversary, CalendarEvent, Participant, Task } from '../types';
import { nextOccurrenceDate } from './anniversary';
import { DB } from './db';
import { REAL_IDENTITY_PERSONA_ID } from './userPersona';
import { todoTitleMatches } from './todoTagParse';

export const sameParticipant = (a: Participant | null | undefined, b: Participant | null | undefined): boolean =>
    !!a && !!b && a.kind === b.kind && a.id === b.id;

export const personaParticipant = (personaKey: string | undefined): Participant => ({ kind: 'persona', id: personaKey || REAL_IDENTITY_PERSONA_ID });
export const charParticipant = (charId: string): Participant => ({ kind: 'char', id: charId });

export const makeEventId = (): string => `cal-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

/** 這條在這天嗎（紀念日看今年那次；待辦看截止日；有時段的看開始那天） */
export const eventOnDay = (e: CalendarEvent, dayKey: string): boolean => {
    const startDay = e.start.slice(0, 10);
    if (e.repeat === 'yearly') {
        return startDay === dayKey || nextOccurrenceDate({ date: startDay, repeatAnnually: true }, dayKey) === dayKey;
    }
    if (e.end && !e.allDay && e.kind === 'event') {
        const endDay = e.end.slice(0, 10);
        return startDay <= dayKey && dayKey <= endDay;
    }
    return startDay === dayKey;
};

export const eventsOn = (events: CalendarEvent[], dayKey: string): CalendarEvent[] => events.filter(e => eventOnDay(e, dayKey));

/** 這個人名下的（owner）加上他有份的（participants） */
export const eventsInvolving = (events: CalendarEvent[], who: Participant): CalendarEvent[] =>
    events.filter(e => sameParticipant(e.owner, who) || (e.participants || []).some(p => sameParticipant(p, who)));

export const ownedBy = (events: CalendarEvent[], who: Participant): CalendarEvent[] => events.filter(e => sameParticipant(e.owner, who));

/** 'YYYY-MM-DDTHH:mm' → 'HH:mm'；全天或只有日期回 undefined */
export const eventTime = (e: CalendarEvent, which: 'start' | 'end' = 'start'): string | undefined => {
    if (e.allDay) return undefined;
    const v = which === 'start' ? e.start : e.end;
    return v && v.length >= 16 ? v.slice(11, 16) : undefined;
};

/** 照時間排：全天的在前、再照開始時間 */
export const sortByTime = (events: CalendarEvent[]): CalendarEvent[] =>
    [...events].sort((a, b) => (Number(!a.allDay && a.kind !== 'todo') - Number(!b.allDay && b.kind !== 'todo')) || a.start.localeCompare(b.start));

/** 沒做完的待辦，截止日近的在前、沒截止日的墊後 */
export const openTodos = (events: CalendarEvent[], who?: Participant): CalendarEvent[] =>
    events
        .filter(e => e.kind === 'todo' && !e.done && (!who || sameParticipant(e.owner, who)))
        .sort((a, b) => (a.start || '9999').localeCompare(b.start || '9999'));

/** 紀念日照舊餵給 utils/anniversary.ts（它認的是舊的 Anniversary 形狀） */
export const anniversaryView = (events: CalendarEvent[]): Pick<Anniversary, 'id' | 'title' | 'date' | 'charId' | 'charIds' | 'charRemembers' | 'repeatAnnually'>[] =>
    events.filter(e => e.kind === 'anniversary').map(e => {
        const charIds = (e.participants || []).filter(p => p.kind === 'char').map(p => p.id);
        return { id: e.id, title: e.title, date: e.start.slice(0, 10), charId: charIds[0] || '', charIds, charRemembers: e.charRemembers, repeatAnnually: e.repeat === 'yearly' };
    });

/** 新建一條（補齊 id、時間戳） */
export const newEvent = (fields: Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt'> & Partial<Pick<CalendarEvent, 'id'>>): CalendarEvent => {
    const now = Date.now();
    return { ...fields, id: fields.id || makeEventId(), createdAt: now, updatedAt: now };
};

/** 角色在聊天裡說做完了：找他名下沒做完、標題對得上的那條；對不上回 null */
export const findTodoToComplete = (events: CalendarEvent[], owner: Participant, title: string): CalendarEvent | null =>
    openTodos(events, owner).find(e => todoTitleMatches(e.title, title)) || null;

// ── 時光契約搬家 ──────────────────────────────────────────────────────────

export const CALENDAR_MIGRATION_KEY = 'soren_calendar_legacy_migrated_v1';

const migrated = (): boolean => { try { return localStorage.getItem(CALENDAR_MIGRATION_KEY) === '1'; } catch { return false; } };
const markMigrated = () => { try { localStorage.setItem(CALENDAR_MIGRATION_KEY, '1'); } catch { /* 存不了下次再搬一次，搬家本身冪等 */ } };

/** tasks → 待辦（真實身份名下）、anniversaries → 紀念日；id 沿用舊的，所以重跑不會疊 */
export const legacyToEvents = (tasks: Task[], anniversaries: Anniversary[], now = Date.now()): CalendarEvent[] => {
    const owner = personaParticipant(REAL_IDENTITY_PERSONA_ID);
    const todos: CalendarEvent[] = tasks.map(t => ({
        id: `legacy-task-${t.id}`, owner, kind: 'todo', title: t.title,
        start: (t.deadline || '').slice(0, 10) || new Date(t.createdAt || now).toISOString().slice(0, 10), allDay: true,
        done: t.isCompleted || undefined, completedAt: t.completedAt, doneBy: t.isCompleted ? 'user' : undefined,
        source: 'user', createdAt: t.createdAt || now, updatedAt: now,
    }));
    const annis: CalendarEvent[] = anniversaries.map(a => {
        const charIds = (a.charIds?.length ? a.charIds : a.charId ? [a.charId] : []).filter(Boolean);
        return {
            id: `legacy-anni-${a.id}`, owner, kind: 'anniversary', title: a.title, start: a.date, allDay: true,
            participants: charIds.map(charParticipant),
            repeat: a.repeatAnnually ? 'yearly' : undefined, charRemembers: a.charRemembers,
            note: a.aiThought, source: 'user', createdAt: now, updatedAt: now,
        };
    });
    return [...todos, ...annis];
};

/** 第一次用到行事曆（或注入）時把時光契約的資料搬進來；搬過就不再動。回搬了幾條 */
export const migrateLegacyCalendar = async (): Promise<number> => {
    if (migrated()) return 0;
    const [tasks, anniversaries] = await Promise.all([DB.getAllTasks().catch(() => [] as Task[]), DB.getAllAnniversaries().catch(() => [] as Anniversary[])]);
    const events = legacyToEvents(tasks, anniversaries);
    for (const e of events) await DB.saveCalendarEvent(e);
    markMigrated();
    return events.length;
};

/** 讀約定層（先確保搬過家） */
export const loadCalendarEvents = async (): Promise<CalendarEvent[]> => {
    await migrateLegacyCalendar();
    return DB.getAllCalendarEvents();
};
