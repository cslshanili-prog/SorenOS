import type { CharacterProfile } from '../types';

/**
 * 日程 / 情緒 buff 總開關判定。
 * - 顯式為 true / false 時直接使用。
 * - undefined 時走向後兼容：老用戶若已選了 scheduleStyle，視為開啟；否則默認關閉。
 * 任何副 API 調用、情緒評估、日程注入之前都應先過此閘門。
 */
export function isScheduleFeatureOn(
    char: Pick<CharacterProfile, 'scheduleFeatureEnabled' | 'scheduleStyle'> | null | undefined,
): boolean {
    if (!char) return false;
    if (char.scheduleFeatureEnabled === true) return true;
    if (char.scheduleFeatureEnabled === false) return false;
    return !!char.scheduleStyle;
}

/**
 * 時段 key 的實現住在 utils/scheduleInjection.ts —— 那是日程渲染的純葉子，
 * 瀏覽器和 Cloudflare Worker（主動消息到點生成）共用同一份。這裡轉發一道，
 * 讓「日程開關」這個入口繼續能一次取到需要的兩樣。
 */
export { getFlowNarrativeKey } from './scheduleInjection';
