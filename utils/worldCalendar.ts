/**
 * 世界的曆法（plans/time-system.md 第 2a 節，第 3 批）：架空時間線掛在神經鏈接的世界（CharacterGroup）上，
 * 同世界的角色和身份卡全跟著走。「輕的」做法＝對現實時間的重映射，不自訂一年幾個月：
 *
 * - 一個對應點：現實 anchorReal（2026-11-17）＝時間線裡的 anchorWorld（3019-03-25）
 * - 年份怎麼寫：epochLabel（「第三紀元 {年} 年」，{年} 換成數字）
 * - 底下照公曆跑：日期＝現實的牆上日期平移 deltaDays 天，月日跟著公曆、時分不動；星期默認不寫
 *
 * 架空世界沒有時區（第 2c 節）：時分照設備時間。節假日只在現實曆法下有。
 * 給模型看的、給你看的，寫日期一律經這裡的 formatCalendar*；私聊／見面的「自定義」時間在架空世界
 * 填的是世界的日期，worldWallClockToTimestamp 把它換回現實時刻。
 */

import type { CharacterGroup, WorldTimeline } from '../types';
import { getWorld } from './charNameRegistry';
import { nowInTimeZone, wallClockToTimestamp } from './timezone';

export const DEFAULT_EPOCH_LABEL = '第三紀元 {年} 年';

const DAY_MS = 86_400_000;
const pad = (n: number) => String(n).padStart(2, '0');
const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];

/** 'YYYY-MM-DD' → 以 UTC 日計的天數（只拿來算兩個日期差幾天，跟時區無關） */
const dayNumber = (ymd: string): number => {
    const m = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})$/.exec(ymd.trim());
    if (!m) return NaN;
    return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / DAY_MS);
};

/** 現實的日子要平移幾天才是時間線裡的日子；對應點沒填好回 0（＝不平移，只換年份寫法） */
export const timelineDeltaDays = (timeline: Pick<WorldTimeline, 'anchorReal' | 'anchorWorld'>): number => {
    const a = dayNumber(timeline.anchorReal || '');
    const b = dayNumber(timeline.anchorWorld || '');
    return Number.isFinite(a) && Number.isFinite(b) ? b - a : 0;
};

/** 時間線寫出來的年份：「第三紀元 3019 年」；epochLabel 沒有 {年} 就接在後面 */
export const formatEpochYear = (timeline: Pick<WorldTimeline, 'epochLabel'>, year: number): string => {
    const label = (timeline.epochLabel || '').trim() || DEFAULT_EPOCH_LABEL;
    return label.includes('{年}') ? label.replace(/\{年\}/g, String(year)) : `${label} ${year}`;
};

export interface CalendarParts {
    year: number; month: number; day: number; hour: number; minute: number;
    /** 0=週日；架空曆法算的是平移後那天的星期（底下照公曆跑） */
    weekday: number;
}

/** 一個真實時刻在這套曆法、這個時區裡是幾年幾月幾日幾點 */
export const calendarParts = (ms: number, tz: string | undefined, timeline: WorldTimeline | undefined): CalendarParts => {
    const d = nowInTimeZone(tz, new Date(ms));
    if (!timeline) return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), hour: d.getHours(), minute: d.getMinutes(), weekday: d.getDay() };
    const shifted = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) + timelineDeltaDays(timeline) * DAY_MS);
    return { year: shifted.getUTCFullYear(), month: shifted.getUTCMonth() + 1, day: shifted.getUTCDate(), hour: d.getHours(), minute: d.getMinutes(), weekday: shifted.getUTCDay() };
};

/** 日期戳 `3019-03-25`（記錄上的時間戳、日期 key 用；現實曆法就是 `2026-11-17`） */
export const calendarDateStamp = (ms: number, tz: string | undefined, timeline: WorldTimeline | undefined): string => {
    const p = calendarParts(ms, tz, timeline);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/** 時間戳 `3019-03-25 03:00`（記錄上每則前面那個） */
export const calendarStamp = (ms: number, tz: string | undefined, timeline: WorldTimeline | undefined): string => {
    const p = calendarParts(ms, tz, timeline);
    return `${calendarDateStamp(ms, tz, timeline)} ${pad(p.hour)}:${pad(p.minute)}`;
};

/**
 * 給模型／給你看的那句：「2026年11月17日 週二 下午 14:16」或「第三紀元 3019 年 3 月 25 日 下午 14:16」。
 * 架空曆法的星期默認不寫（timeline.showWeekday 才寫，plans/time-system.md 第 6 節）。
 */
export const formatCalendarText = (
    ms: number,
    tz: string | undefined,
    timeline: WorldTimeline | undefined,
    opts: { time?: boolean; timeOfDay?: string } = {},
): string => {
    const p = calendarParts(ms, tz, timeline);
    const weekday = timeline ? (timeline.showWeekday ? ` ${WEEKDAYS[p.weekday]}` : '') : ` ${WEEKDAYS[p.weekday]}`;
    const datePart = timeline
        ? `${formatEpochYear(timeline, p.year)} ${p.month} 月 ${p.day} 日`
        : `${p.year}年${p.month}月${p.day}日`;
    const timeOfDay = opts.timeOfDay ? ` ${opts.timeOfDay}` : '';
    const time = opts.time === false ? '' : ` ${pad(p.hour)}:${pad(p.minute)}`;
    return `${datePart}${weekday}${timeOfDay}${time}`;
};

/** 見面設定那種寫法：`3019-03-25 03:00 週二`（架空不寫星期，除非開了） */
export const formatCalendarClock = (ms: number, tz: string | undefined, timeline: WorldTimeline | undefined): string => {
    const p = calendarParts(ms, tz, timeline);
    const weekday = !timeline || timeline.showWeekday ? ` ${WEEKDAYS[p.weekday]}` : '';
    return `${calendarStamp(ms, tz, timeline)}${weekday}`;
};

/** 「此刻」在這套曆法裡的 'YYYY-MM-DDTHH:mm'（給 datetime-local 當起點） */
export const calendarWallNow = (tz: string | undefined, timeline: WorldTimeline | undefined, ms = Date.now()): string => {
    const p = calendarParts(ms, tz, timeline);
    return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
};

/**
 * 逆運算：照這套曆法寫的牆上時間（'3019-03-25T03:00'）→ 真實時刻。
 * 架空的先把日子平移回現實，再交給 wallClockToTimestamp 照時區解讀。
 */
export const worldWallClockToTimestamp = (text: string, tz: string | undefined, timeline: WorldTimeline | undefined): number => {
    if (!timeline) return wallClockToTimestamp(text, tz);
    const m = /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})[T ](\d{1,2}):(\d{2})/.exec(text.trim());
    if (!m) return NaN;
    const realDay = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) - timelineDeltaDays(timeline) * DAY_MS);
    const realText = `${realDay.getUTCFullYear()}-${pad(realDay.getUTCMonth() + 1)}-${pad(realDay.getUTCDate())}T${m[4].padStart(2, '0')}:${m[5]}`;
    return wallClockToTimestamp(realText, tz);
};

/** 角色所在世界的時間線（架空曆法）；沒分世界、或世界是現實曆法就 undefined */
export const resolveCharCalendar = (char: { groupId?: string } | null | undefined): WorldTimeline | undefined =>
    worldCalendar(getWorld(char?.groupId));

/** 世界的時間線（填了對應點才算有） */
export const worldCalendar = (world: Pick<CharacterGroup, 'timeline'> | null | undefined): WorldTimeline | undefined =>
    world?.timeline?.anchorReal && world.timeline.anchorWorld ? world.timeline : undefined;
