import { Anniversary, CharacterProfile } from '../types';

/**
 * 纪念日关联对象的角色 id 列表（多选）。charIds 是新字段；旧数据只有单选的 charId 时
 * 兜底成单元素数组，全站读取关联对象一律走这个函数，不要直接读 .charId / .charIds。
 */
export function anniversaryCharIds(anni: Pick<Anniversary, 'charId' | 'charIds'>): string[] {
    if (anni.charIds && anni.charIds.length > 0) return anni.charIds;
    return anni.charId ? [anni.charId] : [];
}

/** 关联对象的显示名字，多个用顿号连接；一个都找不到时兜底 'Unknown'（跟旧文案保持一致）。 */
export function anniversaryCharNames(
    anni: Pick<Anniversary, 'charId' | 'charIds'>,
    characters: Pick<CharacterProfile, 'id' | 'name'>[],
): string {
    const names = anniversaryCharIds(anni)
        .map(id => characters.find(c => c.id === id)?.name)
        .filter((n): n is string => !!n);
    return names.length > 0 ? names.join('、') : 'Unknown';
}

/**
 * 纪念日"下一次会到来的日期"。非重复纪念日原样返回锚点日期（过了就是过了，符合现状默认行为）；
 * 开了「每年重复提醒」的，若锚点日期的月/日在今年已经过了，换算成明年同一天，否则就是今年。
 * 只用于"即将到来"这类前瞻性展示——纪念日本身的 date 字段（历史锚点）永远不因这个函数而改写。
 */
const DAY_MS = 86_400_000;
const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const dateKeyToUtc = (key: string): number => {
    const [y, m, d] = key.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
};

const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * 「讓 TA 記住這一天」用的下一次（含今天）日期：原始日期還沒到就是原始日期本身，
 * 過了就按月日每年一次。2/29 在平年落到 2/28，不然四年才記得一次。
 * 跟 nextOccurrenceDate 分開：那個看的是「重複提醒」開關，這個是角色自己每年都記得。
 */
function rememberedOccurrenceKey(dateKey: string, todayKey: string): string | null {
    const m = DATE_KEY_RE.exec(dateKey);
    if (!m) return null;
    if (dateKey >= todayKey) return dateKey;
    const [, , mm, dd] = m;
    const occurrence = (y: number) => `${y}-${mm}-${mm === '02' && dd === '29' && !isLeapYear(y) ? '28' : dd}`;
    const year = Number(todayKey.slice(0, 4));
    const thisYear = occurrence(year);
    return thisYear >= todayKey ? thisYear : occurrence(year + 1);
}

export interface AnniversaryReminder {
    title: string;
    occurrenceKey: string;
    daysUntil: number;
    /** 距離原始日期滿幾年；0 = 就是原始那天本身。 */
    years: number;
}

/** 這個角色開了「讓 TA 記住這一天」、而且落在 windowDays 天內（含今天）的紀念日，近的在前。 */
export function collectAnniversaryReminders(
    anniversaries: Pick<Anniversary, 'title' | 'date' | 'charId' | 'charIds' | 'charRemembers'>[],
    charId: string,
    todayKey: string,
    windowDays: number,
): AnniversaryReminder[] {
    const result: AnniversaryReminder[] = [];
    for (const anni of anniversaries) {
        if (!anni.charRemembers || !anniversaryCharIds(anni).includes(charId)) continue;
        const occurrenceKey = rememberedOccurrenceKey(anni.date, todayKey);
        if (!occurrenceKey) continue;
        const daysUntil = Math.round((dateKeyToUtc(occurrenceKey) - dateKeyToUtc(todayKey)) / DAY_MS);
        if (daysUntil < 0 || daysUntil > windowDays) continue;
        const years = Number(occurrenceKey.slice(0, 4)) - Number(anni.date.slice(0, 4));
        result.push({ title: anni.title, occurrenceKey, daysUntil, years });
    }
    return result.sort((a, b) => a.daysUntil - b.daysUntil);
}

const monthDayLabel = (key: string) => `${Number(key.slice(5, 7))}月${Number(key.slice(8, 10))}日`;

/**
 * 注入聊天系統提示詞的「你記得的日子」段落；沒有要提的就回空字串。
 *
 * forFirePack：主動消息的模板是先打包、到點才渲染，「今天／明天」這種相對說法會過期，
 * 所以只列絕對日期、窗口放寬到 7 天，讓角色對照到點時渲染進去的當前時間自己判斷。
 */
export function buildAnniversaryInjection(
    anniversaries: Pick<Anniversary, 'title' | 'date' | 'charId' | 'charIds' | 'charRemembers'>[],
    charId: string,
    todayKey: string,
    options: { forFirePack?: boolean } = {},
): string {
    const forFirePack = options.forFirePack === true;
    const reminders = collectAnniversaryReminders(anniversaries, charId, todayKey, forFirePack ? 7 : 3);
    if (reminders.length === 0) return '';

    const yearsNote = (r: AnniversaryReminder) => (r.years > 0 ? `，到這次是第 ${r.years} 年` : '');

    if (forFirePack) {
        const lines = reminders.map(r => `- ${monthDayLabel(r.occurrenceKey)}「${r.title}」${yearsNote(r)}`);
        return `\n### 📅【你記得的日子】\n${lines.join('\n')}\n（對照當前時間：是今天的話，找個自然的時機提起；還沒到的，放在心上就好。）\n`;
    }

    const lines = reminders.map(r => {
        const when = r.daysUntil === 0 ? '今天' : r.daysUntil === 1 ? '明天' : `${r.daysUntil} 天後`;
        return `- ${when}（${monthDayLabel(r.occurrenceKey)}）是「${r.title}」${yearsNote(r)}。`;
    });
    return `\n### 📅【你記得的日子】\n${lines.join('\n')}\n（這些是你放在心上的日子。今天的那個，找個自然的時機提起——一句話、一個小心意都好，別像在念備忘錄；還沒到的，可以默默記著，或輕輕帶一句。）\n`;
}

export function nextOccurrenceDate(
    anni: Pick<Anniversary, 'date' | 'repeatAnnually'>,
    todayKey: string,
): string {
    if (!anni.repeatAnnually) return anni.date;
    const parts = anni.date.split('-');
    if (parts.length !== 3) return anni.date;
    const [, mm, dd] = parts;
    const todayYear = todayKey.split('-')[0];
    const thisYearOccurrence = `${todayYear}-${mm}-${dd}`;
    if (thisYearOccurrence >= todayKey) return thisYearOccurrence;
    return `${Number(todayYear) + 1}-${mm}-${dd}`;
}
