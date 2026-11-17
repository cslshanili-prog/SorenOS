/**
 * 消化一條 `schedule-generate` 結果（雲端到點排好的一天，plans/calendar.md 第 5 批）。
 * 落地跟本機生成同一套：名字對回 id、待辦對回 todoId、doneTodos 勾掉（scheduleGenParts），存 DailySchedule，打髒雲端。
 * 本機已經排了那天（頁面開著時本機先跑了）就銷帳丟棄，不蓋。
 */

import type { CalendarEvent, DailySchedule, ScheduleSlot } from '../types';
import { DB } from './db';
import { parseScheduleGenerateResult } from './amsgScheduleJob';
import type { AmsgResultContext } from './amsgResults';
import { loadCalendarEvents } from './calendarEvents';
import { openTodosOf, resolveDoneTodos, toScheduleSlot } from './scheduleGenParts';
import { loadNamedParticipants } from './scheduleGenerator';
import { markAmsgStateDirty } from './amsgStateSync';
import { resolveUserProfileForChar } from './userPersona';
import { TODO_CHANGED_EVENT } from './todoTag';

const HEADER = '[amsg2:schedule-generate]';
/** 結果晚到太多就不用了：那天早過了 */
const RESULT_MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000;

export const applyScheduleGenerateResult = async (payload: unknown, context?: AmsgResultContext): Promise<boolean> => {
    const result = parseScheduleGenerateResult(payload);
    if (!result) {
        console.warn(`${HEADER} 結果形狀認不出來，丟棄`, payload);
        return true;
    }
    const at = context?.createdAt || result.generatedAt || Date.now();
    if (Date.now() - at > RESULT_MAX_AGE_MS) {
        console.warn(`${HEADER} 結果太舊（${result.dateKey}），丟棄`);
        return true;
    }
    const char = (await DB.getAllCharacters()).find(c => c.id === result.charId);
    if (!char) {
        console.warn(`${HEADER} 找不到角色 ${result.charId}（已刪除？），銷帳丟棄`);
        return true;
    }
    const existing = await DB.getDailySchedule(char.id, result.dateKey).catch(() => null);
    if (existing) {
        console.log(`${HEADER} ${char.name} ${result.dateKey} 本機已經有日程，雲端這份不蓋`);
        return true;
    }

    const [events, people] = await Promise.all([loadCalendarEvents().catch(() => [] as CalendarEvent[]), loadNamedParticipants()]);
    const owner = { kind: 'char' as const, id: char.id };
    const todos = openTodosOf(events, owner);
    const slots = ((result.parsed.slots || []) as any[]).map(s => toScheduleSlot(s, people, owner, todos)).filter((s): s is ScheduleSlot => !!s);
    if (slots.length === 0) {
        console.warn(`${HEADER} 結果裡沒有可用的時段，丟棄`);
        return true;
    }
    slots.sort((a, b) => a.startTime.localeCompare(b.startTime));
    let flowNarrative: Record<string, string> | undefined;
    const fn = result.parsed.flowNarrative;
    if (fn && typeof fn === 'object') {
        flowNarrative = {};
        for (const key of ['morning', 'afternoon', 'evening']) {
            const v = (fn as Record<string, unknown>)[key];
            if (typeof v === 'string' && v.trim()) flowNarrative[key] = v.trim();
        }
        if (Object.keys(flowNarrative).length === 0) flowNarrative = undefined;
    }
    let coverImage: string | undefined;
    try { coverImage = (await DB.getScheduleCoverImage(char.id)) || undefined; } catch { /* 沒有就沒有 */ }

    const schedule: DailySchedule = { id: `${char.id}_${result.dateKey}`, charId: char.id, date: result.dateKey, slots, generatedAt: at, coverImage, flowNarrative };
    await DB.saveDailySchedule(schedule);
    const now = Date.now();
    for (const t of resolveDoneTodos(result.parsed.doneTodos, todos)) {
        await DB.saveCalendarEvent({ ...t, done: true, doneBy: 'ai', completedAt: now, updatedAt: now }).catch(() => {});
    }
    try { window.dispatchEvent(new CustomEvent(TODO_CHANGED_EVENT, { detail: { owner } })); } catch { /* 沒有 window */ }

    const [userProfile, groups] = await Promise.all([DB.getUserProfile().catch(() => null), DB.getGroups().catch(() => undefined)]);
    if (userProfile && groups) markAmsgStateDirty({ char, userProfile: resolveUserProfileForChar(userProfile, char), groups });
    console.log(`${HEADER} ${char.name} ${result.dateKey} 的日程落地（${slots.length} 段）`);
    return true;
};
