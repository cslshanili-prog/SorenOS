/**
 * 角色的「時間感知」三檔（plans/time-system.md 第 2d 節）：這個角色對時間敏不敏感，性格級的，存在角色卡上。
 *
 * | 檔 | 現在幾點 | 距上次多久 | 歷史時間戳 | 節假日 |
 * |---|---|---|---|---|
 * | precise 精確（默認） | 到分 | 給 | `[2026-11-16 23:41]` | 給 |
 * | coarse 粗略 | 只有日期＋早中晚 | 只到「幾天」 | 只標日期 `[2026-11-16]` | 給 |
 * | none 不知道 | 不給 | 不給 | 不標 | 不給 |
 *
 * 存法：新欄位 `timeAwareness` 記檔位；舊的布林 `timeAwarenessEnabled` 一起寫（none → false，其餘 true），
 * 雲端（tool_pack）和還在讀布林的地方照舊能用——粗略在雲端等於精確（第 1 批先這樣，見設計稿第 6 節）。
 * 讀一律走 resolveTimeAwareness：沒新欄位時 `false` → none、其餘 → precise。
 */

import type { CharacterProfile } from '../types';

export type TimeAwarenessLevel = 'precise' | 'coarse' | 'none';

export const TIME_AWARENESS_OPTIONS: ReadonlyArray<{ value: TimeAwarenessLevel; label: string; hint: string }> = [
    { value: 'precise', label: '精確', hint: '知道現在幾點幾分、你們隔了多久沒聊，記錄上每句都有時間。' },
    { value: 'coarse', label: '粗略', hint: '只知道今天幾號、早中晚，隔了幾天才算得出來，記錄上只標日期。' },
    { value: 'none', label: '不知道', hint: '完全沒有時間概念：不報時、不算隔了多久、記錄不標時間、也不知道節日。' },
];

type TimeAwarenessFields = Pick<CharacterProfile, 'timeAwareness' | 'timeAwarenessEnabled'>;

export const resolveTimeAwareness = (char: TimeAwarenessFields | null | undefined): TimeAwarenessLevel => {
    const level = char?.timeAwareness;
    if (level === 'precise' || level === 'coarse' || level === 'none') return level;
    return char?.timeAwarenessEnabled === false ? 'none' : 'precise';
};

/** 介面改檔位時寫這兩個欄位（新欄位記檔位、舊布林跟著同步） */
export const timeAwarenessPatch = (level: TimeAwarenessLevel): Pick<CharacterProfile, 'timeAwareness' | 'timeAwarenessEnabled'> => ({
    timeAwareness: level,
    timeAwarenessEnabled: level !== 'none',
});

/** 不是「不知道」就算有時間感知（舊的 `timeAwarenessEnabled !== false` 一律改問這個） */
export const hasTimeAwareness = (char: TimeAwarenessFields | null | undefined): boolean => resolveTimeAwareness(char) !== 'none';

const WEEKDAYS = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const pad = (n: number) => String(n).padStart(2, '0');

/** 幾點鐘 → 早中晚那個詞（跟 buildTimeAwarenessBlock 同一套刻度） */
export const timeOfDayWord = (hour: number): string =>
    hour < 5 ? '凌晨' : hour < 9 ? '早晨' : hour < 12 ? '上午' : hour < 14 ? '中午'
    : hour < 17 ? '下午' : hour < 19 ? '傍晚' : hour < 22 ? '晚上' : '深夜';

/** 日期 key：`2026-11-16`（d 已經是牆上時間，用本地 getter 讀） */
export const dateStamp = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** 粗略那檔的「現在是」：日期＋星期＋早中晚，沒有幾點幾分 */
export const coarseNowText = (d: Date): string => `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]} ${timeOfDayWord(d.getHours())}`;

/** 粗略那檔的「隔了多久」：不滿一天就當沒隔，滿一天只說幾天 */
export const coarseGapDays = (diffMs: number): number => (diffMs < 0 ? 0 : Math.floor(diffMs / 86_400_000));
