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
