/**
 * 約定的「期」（plans/bond-batch4.md 1.3）。期照你裝置的日期算（約定是你們兩個一起做的，跟角色時區無關）。
 * 純函式，日期一律是 'YYYY-MM-DD' 字串。
 *
 * - 每天：那一天 'YYYY-MM-DD'
 * - 每週：ISO 週 'YYYY-Www'（週一開始）；有指定星期幾的，只有那幾天算數
 * - 每月：'YYYY-MM'
 * - 每幾天：從開始那天起每 n 天一期，期鍵是那一期第一天 'YYYY-MM-DD'
 * - 每年：'YYYY'，只有那個日期（MM-DD）那天算數
 * - 一次：'once'
 */
import type { BondPromiseRepeat } from '../../types';

const pad = (n: number) => String(n).padStart(2, '0');

export function dayKeyOf(ts: number): string {
    const d = new Date(ts);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 'YYYY-MM-DD' 當地午夜 → 數字日（自 1970-01-01 起的第幾天，不受夏令時影響） */
export function dayNumber(day: string): number {
    const [y, m, d] = day.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function dayFromNumber(n: number): string {
    const d = new Date(n * 86_400_000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export const addDays = (day: string, n: number): string => dayFromNumber(dayNumber(day) + n);

/** 當地午夜的時間戳（撈那天的訊息用） */
export function dayStartTs(day: string): number {
    const [y, m, d] = day.split('-').map(Number);
    return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}

/** 星期幾：0＝週日 */
export const weekdayOf = (day: string): number => new Date(dayNumber(day) * 86_400_000).getUTCDay();

/** ISO 週 'YYYY-Www' */
export function isoWeekKey(day: string): string {
    const n = dayNumber(day);
    const wd = (weekdayOf(day) + 6) % 7; // 週一＝0
    const thursday = n - wd + 3;
    const t = new Date(thursday * 86_400_000);
    const year = t.getUTCFullYear();
    const jan1 = Math.floor(Date.UTC(year, 0, 1) / 86_400_000);
    const week = Math.floor((thursday - jan1) / 7) + 1;
    return `${year}-W${pad(week)}`;
}

/** 某一天屬於哪一期；anchor 是約定開始那天（每幾天用） */
export function periodKeyOf(repeat: BondPromiseRepeat, day: string, anchor?: string): string {
    switch (repeat.kind) {
        case 'once': return 'once';
        case 'daily': return day;
        case 'weekly': return isoWeekKey(day);
        case 'monthly': return day.slice(0, 7);
        case 'yearly': return day.slice(0, 4);
        case 'everyNDays': {
            const n = Math.max(1, repeat.n || 1);
            const a = anchor ? dayNumber(anchor) : dayNumber(day);
            const offset = dayNumber(day) - a;
            return dayFromNumber(a + Math.floor(offset / n) * n);
        }
    }
}

/** 這一天做的算不算數（有指定星期幾的每週、每年那一天） */
export function countsOnDay(repeat: BondPromiseRepeat, day: string): boolean {
    if (repeat.kind === 'weekly' && repeat.days?.length) return repeat.days.includes(weekdayOf(day));
    if (repeat.kind === 'yearly') return day.slice(5) === repeat.date;
    return true;
}

/** 一期的最後一天（判「這期結束了沒」用；一次性的沒有結束） */
export function periodLastDay(repeat: BondPromiseRepeat, periodKey: string): string | null {
    switch (repeat.kind) {
        case 'once': return null;
        case 'daily': return periodKey;
        case 'weekly': {
            const [y, w] = periodKey.split('-W').map(Number);
            // 那年 1/4 一定在第 1 週
            const jan4 = `${y}-01-04`;
            const monday = dayNumber(jan4) - ((weekdayOf(jan4) + 6) % 7);
            return dayFromNumber(monday + (w - 1) * 7 + 6);
        }
        case 'monthly': {
            const [y, m] = periodKey.split('-').map(Number);
            return dayFromNumber(Math.floor(Date.UTC(y, m, 1) / 86_400_000) - 1);
        }
        case 'yearly': return `${periodKey}-12-31`;
        case 'everyNDays': return addDays(periodKey, Math.max(1, repeat.n || 1) - 1);
    }
}

/** 上一期的期鍵（連續天數用）；一次性的沒有 */
export function previousPeriodKey(repeat: BondPromiseRepeat, periodKey: string): string | null {
    switch (repeat.kind) {
        case 'once': return null;
        case 'daily': return addDays(periodKey, -1);
        case 'weekly': {
            const last = periodLastDay(repeat, periodKey)!;
            return isoWeekKey(addDays(last, -7));
        }
        case 'monthly': {
            const [y, m] = periodKey.split('-').map(Number);
            return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
        }
        case 'yearly': return String(Number(periodKey) - 1);
        case 'everyNDays': return addDays(periodKey, -Math.max(1, repeat.n || 1));
    }
}

/** 給人看的期：今天／這週／這個月… */
export function periodWord(repeat: BondPromiseRepeat): string {
    switch (repeat.kind) {
        case 'daily': return '今天';
        case 'weekly': return '這週';
        case 'monthly': return '這個月';
        case 'yearly': return '今年';
        case 'everyNDays': return '這一輪';
        case 'once': return '';
    }
}
