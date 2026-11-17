/**
 * 行事曆的純邏輯（plans/calendar.md 第 1 批）：月格子、時段的起訖、一條時間在「這個人那邊」和「你那邊」各是幾點、
 * 身份卡清單。只算不渲染，App 在 apps/CalendarApp.tsx。
 *
 * 時間一律照 plans/time-system.md：角色那邊幾點用 resolveCharTimeZone（先看世界）、你那邊用身份卡的所在地
 * （UserProfile.timezone，沒設＝設備）、架空曆法的日期用 utils/worldCalendar.ts 寫。
 */

import type { Anniversary, CharacterProfile, ScheduleSlot, Task, UserProfile, WorldTimeline } from '../types';
import { nextOccurrenceDate } from './anniversary';
import { getLocalDateKey } from './localDate';
import { nowInTimeZone, wallClockToTimestamp } from './timezone';
import { personaAvatarForKey, personaNameForKey, profileForPersonaKey, REAL_IDENTITY_PERSONA_ID } from './userPersona';
import { formatCalendarText } from './worldCalendar';

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');

/** 'YYYY-MM-DD' → 以 UTC 日計的天數；加減幾天用它，別碰設備時區 */
export const dayNumber = (key: string): number => {
    const [y, m, d] = key.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / DAY_MS);
};
export const dayKeyFromNumber = (n: number): string => {
    const d = new Date(n * DAY_MS);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};
export const addDays = (key: string, days: number): string => dayKeyFromNumber(dayNumber(key) + days);
/** 'YYYY-MM' */
export const monthKeyOf = (dayKey: string): string => dayKey.slice(0, 7);
export const addMonths = (monthKey: string, delta: number): string => {
    const [y, m] = monthKey.split('-').map(Number);
    const total = y * 12 + (m - 1) + delta;
    return `${Math.floor(total / 12)}-${pad((total % 12) + 1)}`;
};

export interface MonthCell { key: string; inMonth: boolean; day: number }

/** 月格子：6 行 × 7 欄，週日開頭；格子外的日子 inMonth=false（也回傳，好打點） */
export const monthGrid = (monthKey: string): MonthCell[][] => {
    const [y, m] = monthKey.split('-').map(Number);
    const first = Date.UTC(y, m - 1, 1);
    const firstWeekday = new Date(first).getUTCDay();
    const start = Math.floor(first / DAY_MS) - firstWeekday;
    const rows: MonthCell[][] = [];
    for (let r = 0; r < 6; r++) {
        const row: MonthCell[] = [];
        for (let c = 0; c < 7; c++) {
            const key = dayKeyFromNumber(start + r * 7 + c);
            row.push({ key, inMonth: key.slice(0, 7) === monthKey, day: Number(key.slice(8, 10)) });
        }
        rows.push(row);
    }
    // 最後一行整行都是下個月就不要
    return rows[5].every(c => !c.inMonth) ? rows.slice(0, 5) : rows;
};

/** 月格子的頭尾日 */
export const monthRange = (monthKey: string): { from: string; to: string } => {
    const grid = monthGrid(monthKey);
    return { from: grid[0][0].key, to: grid[grid.length - 1][6].key };
};

export interface SlotRange {
    index: number;
    slot: ScheduleSlot;
    /** 'HH:MM' */
    start: string;
    /** 下一段的開始；最後一段沒有 */
    end?: string;
}

/** 時段的起訖：結束＝下一段的開始（日程表只存開始時間） */
export const slotRanges = (slots: ScheduleSlot[]): SlotRange[] =>
    slots.map((slot, index) => ({ index, slot, start: slot.startTime, end: slots[index + 1]?.startTime }));

/** 某天某個牆上時間（在 tz 那邊）→ 真實時刻 */
export const wallToMs = (dayKey: string, hhmm: string, tz: string | undefined): number =>
    wallClockToTimestamp(`${dayKey}T${hhmm}`, tz);

const hhmmIn = (ms: number, tz: string | undefined): string => {
    const d = nowInTimeZone(tz, new Date(ms));
    return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

export interface DualTime {
    /** 這個人那邊 */
    local: string;
    /** 你那邊；跟 local 一樣（同時區）就 undefined，介面不重複寫 */
    yours?: string;
    /** 你那邊是不是另一天（隔天 +1 ／前一天 -1） */
    yoursDayOffset?: number;
}

/**
 * 一條時間在「這個人那邊」和「你那邊」各是幾點。兩邊時區都沒設（或一樣）就只有 local。
 * 架空曆法的世界沒有時區（第 3 批），那邊的時間就是設備時間，跟你一樣。
 */
export const dualTime = (dayKey: string, hhmm: string, localTz: string | undefined, yourTz: string | undefined): DualTime => {
    if ((localTz || '') === (yourTz || '')) return { local: hhmm };
    const ms = wallToMs(dayKey, hhmm, localTz);
    if (!Number.isFinite(ms)) return { local: hhmm };
    const yours = hhmmIn(ms, yourTz);
    const yourDay = getLocalDateKey(nowInTimeZone(yourTz, new Date(ms)));
    const offset = dayNumber(yourDay) - dayNumber(dayKey);
    return { local: hhmm, yours, ...(offset ? { yoursDayOffset: offset } : {}) };
};

export interface PersonaOption {
    key: string;
    name: string;
    avatar: string;
    timezone?: string;
    /** 主線：全域默認那張（沒設就是真實身份） */
    isMain: boolean;
}

/** 「我的」分頁的身份卡清單：真實身份在前、再來各張卡；主線那張標出來 */
export const personaOptions = (profileBase: UserProfile): PersonaOption[] => {
    const mainKey = profileBase.activePersonaId && profileBase.personas?.some(p => p.id === profileBase.activePersonaId)
        ? profileBase.activePersonaId
        : REAL_IDENTITY_PERSONA_ID;
    const keys = [REAL_IDENTITY_PERSONA_ID, ...(profileBase.personas || []).map(p => p.id)];
    return keys.map(key => ({
        key,
        name: personaNameForKey(profileBase, key),
        avatar: personaAvatarForKey(profileBase, key),
        timezone: profileForPersonaKey(profileBase, key).timezone,
        isMain: key === mainKey,
    }));
};

/** 這張身份卡「今天」是哪一天（照它的所在地；沒設照設備） */
export const personaTodayKey = (timezone: string | undefined, now = new Date()): string => getLocalDateKey(nowInTimeZone(timezone, now));

/** 待辦：截止日落在這天的 */
export const tasksOn = (tasks: Task[], dayKey: string): Task[] => tasks.filter(t => (t.deadline || '').slice(0, 10) === dayKey);

/** 紀念日：這天是它（重複的看今年那次） */
export const anniversariesOn = (anniversaries: Anniversary[], dayKey: string): Anniversary[] =>
    anniversaries.filter(a => nextOccurrenceDate(a, dayKey) === dayKey || a.date === dayKey);

/** 月格子上打點用：這天有哪幾種東西 */
export interface DayMarks { schedule: boolean; todo: boolean; anniversary: boolean }
export const dayMarks = (dayKey: string, scheduleDays: ReadonlySet<string>, tasks: Task[], anniversaries: Anniversary[]): DayMarks => ({
    schedule: scheduleDays.has(dayKey),
    todo: tasksOn(tasks, dayKey).length > 0,
    anniversary: anniversariesOn(anniversaries, dayKey).length > 0,
});

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
/** 「11月17日（週二）」；架空曆法照世界的寫法 */
export const dayTitle = (dayKey: string, timeline?: WorldTimeline): string => {
    if (timeline) return formatCalendarText(wallToMs(dayKey, '12:00', undefined), undefined, timeline, { time: false });
    const [, m, d] = dayKey.split('-').map(Number);
    const weekday = WEEKDAYS[new Date(Date.UTC(Number(dayKey.slice(0, 4)), m - 1, d)).getUTCDay()];
    return `${m}月${d}日（${weekday}）`;
};

/** 一段的狀態：過了／進行中／還沒到（照這個人那邊的現在） */
export const rangeState = (dayKey: string, range: SlotRange, tz: string | undefined, nowMs = Date.now()): 'past' | 'now' | 'future' => {
    const start = wallToMs(dayKey, range.start, tz);
    const end = range.end ? wallToMs(dayKey, range.end, tz) : wallToMs(addDays(dayKey, 1), '00:00', tz);
    if (nowMs >= end) return 'past';
    if (nowMs >= start) return 'now';
    return 'future';
};

/** 這個角色今天在做什麼（頭上那句）：進行中的那段 */
export const currentActivity = (dayKey: string, slots: ScheduleSlot[], tz: string | undefined, nowMs = Date.now()): ScheduleSlot | undefined =>
    slotRanges(slots).find(r => rangeState(dayKey, r, tz, nowMs) === 'now')?.slot;

export type CharLike = Pick<CharacterProfile, 'id' | 'name' | 'avatar' | 'customTimezoneEnabled' | 'customTimezone' | 'groupId'>;

/** 「今日次元重疊」的一列：某個角色的某段 */
export interface OverlapRow { char: CharLike; range: SlotRange; time: DualTime; state: 'past' | 'now' | 'future' }

/** 把好幾個角色當天的時段混在一起、照「你那邊」的時刻排 */
export const overlapRows = (
    dayKey: string,
    entries: Array<{ char: CharLike; tz: string | undefined; slots: ScheduleSlot[] }>,
    yourTz: string | undefined,
    nowMs = Date.now(),
): OverlapRow[] => {
    const rows: Array<OverlapRow & { sortMs: number }> = [];
    for (const { char, tz, slots } of entries) {
        for (const range of slotRanges(slots)) {
            rows.push({ char, range, time: dualTime(dayKey, range.start, tz, yourTz), state: rangeState(dayKey, range, tz, nowMs), sortMs: wallToMs(dayKey, range.start, tz) });
        }
    }
    return rows.sort((a, b) => a.sortMs - b.sortMs).map(({ sortMs: _s, ...row }) => row);
};
