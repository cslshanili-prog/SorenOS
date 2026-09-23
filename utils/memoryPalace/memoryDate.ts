const DAY_MS = 24 * 60 * 60 * 1000;

function localDayNumber(date: Date): number {
    return Math.floor(Date.UTC(
        date.getFullYear(),
        date.getMonth(),
        date.getDate(),
    ) / DAY_MS);
}

/**
 * 給記憶日期補上相對今天的距離，避免模型把有明確年份的舊事仍誤判成“最近”。
 *
 * 按本地日曆日計算，而不是直接拿毫秒相除；這樣跨夏令時或午夜附近也不會偏一天。
 */
export function formatMemoryDateWithDistance(
    createdAt: number,
    now: number = Date.now(),
): string {
    const date = new Date(createdAt);
    const today = new Date(now);
    if (Number.isNaN(date.getTime()) || Number.isNaN(today.getTime())) return '日期不詳';

    const dayDistance = localDayNumber(today) - localDayNumber(date);
    const relative = dayDistance === 0
        ? '今天'
        : dayDistance > 0
            ? `距今約${dayDistance}天`
            : `約${Math.abs(dayDistance)}天后`;

    const calendarDate = `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
    return `${calendarDate}（${relative}）`;
}
