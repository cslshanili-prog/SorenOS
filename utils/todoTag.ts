/**
 * 待辦標籤落庫（plans/calendar.md 第 2 節）：解析在 utils/todoTagParse.ts（零依賴、worker 共用），這裡接 DB。
 * 角色在聊天裡 `[[TODO|標題|日期]]` 加一條到自己名下、`[[TODO_DONE|標題]]` 勾掉自己的一條（AI 勾的記 doneBy 'ai'）。
 */

import type { CalendarEvent, Participant } from '../types';
import { DB } from './db';
import { charParticipant, findTodoToComplete, loadCalendarEvents, newEvent } from './calendarEvents';
import { extractTodoDirectives, type TodoDirective } from './todoTagParse';

export const TODO_CHANGED_EVENT = 'calendar-todo-changed';

export interface AppliedTodoChanges {
    cleanedText: string;
    added: CalendarEvent[];
    completed: CalendarEvent[];
    /** 說做完了但對不上任何一條 */
    unmatched: string[];
    malformedCount: number;
}

export const applyTodoDirectives = async (directives: TodoDirective[], owner: Participant, now = Date.now()): Promise<Omit<AppliedTodoChanges, 'cleanedText' | 'malformedCount'>> => {
    const added: CalendarEvent[] = [];
    const completed: CalendarEvent[] = [];
    const unmatched: string[] = [];
    if (directives.length === 0) return { added, completed, unmatched };
    const events = await loadCalendarEvents();
    for (const d of directives) {
        if (d.kind === 'add') {
            const e = newEvent({
                owner, kind: 'todo', title: d.title, allDay: true,
                start: d.deadline || new Date(now).toISOString().slice(0, 10),
                source: 'char',
            });
            await DB.saveCalendarEvent(e);
            events.push(e);
            added.push(e);
        } else {
            const target = findTodoToComplete(events, owner, d.title);
            if (!target) { unmatched.push(d.title); continue; }
            const done: CalendarEvent = { ...target, done: true, doneBy: 'ai', completedAt: now, updatedAt: now };
            await DB.saveCalendarEvent(done);
            Object.assign(target, done);
            completed.push(done);
        }
    }
    if (added.length || completed.length) {
        try { window.dispatchEvent(new CustomEvent(TODO_CHANGED_EVENT, { detail: { owner } })); } catch { /* 沒有 window（worker／測試）就算了 */ }
    }
    return { added, completed, unmatched };
};

/** 角色的回覆：剝掉標籤、落庫；回剝乾淨的正文和改了什麼 */
export const applyCharTodoTags = async (content: string, charId: string, now = Date.now()): Promise<AppliedTodoChanges> => {
    const { cleanedText, directives, malformedCount } = extractTodoDirectives(content);
    const applied = await applyTodoDirectives(directives, charParticipant(charId), now);
    return { cleanedText, malformedCount, ...applied };
};
