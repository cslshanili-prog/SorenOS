import type { MomentsInteractionSettings } from '../types';

/** 各數值欄位的範圍與步進，設定頁的滑桿和 normalize 共用這一份。 */
export const MOMENTS_SETTING_RANGES = {
    minPostIntervalHours: { min: 1, max: 168, step: 1 },
    maxPostIntervalHours: { min: 1, max: 168, step: 1 },
    commentProbability: { min: 0, max: 100, step: 5 },
    likeProbability: { min: 0, max: 100, step: 5 },
    firstCommentDelaySec: { min: 0, max: 600, step: 10 },
    commentIntervalSec: { min: 0, max: 600, step: 10 },
    npcInteractionDelayMin: { min: 0, max: 180, step: 5 },
    replyToNpcDelaySec: { min: 0, max: 120, step: 1 },
} as const;

export type MomentsNumericKey = keyof typeof MOMENTS_SETTING_RANGES;

export const DEFAULT_MOMENTS_SETTINGS: MomentsInteractionSettings = {
    autoPostEnabled: false,
    disabledPosterIds: [],
    minPostIntervalHours: 48,
    maxPostIntervalHours: 72,
    commentProbability: 40,
    likeProbability: 75,
    firstCommentDelaySec: 120,
    commentIntervalSec: 60,
    npcInteractionDelayMin: 30,
    replyToNpcDelaySec: 3,
};

const clampTo = (key: MomentsNumericKey, value: unknown): number => {
    const { min, max } = MOMENTS_SETTING_RANGES[key];
    const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MOMENTS_SETTINGS[key];
    return Math.min(max, Math.max(min, Math.round(n)));
};

/** 讀存檔：缺的補預設、超出範圍的夾回來、最長間隔不小於最短間隔、poster 清單去重。 */
export function normalizeMomentsSettings(raw: Partial<MomentsInteractionSettings> | undefined | null): MomentsInteractionSettings {
    const src = raw || {};
    const numeric = Object.fromEntries(
        (Object.keys(MOMENTS_SETTING_RANGES) as MomentsNumericKey[]).map(key => [key, clampTo(key, src[key])]),
    ) as Pick<MomentsInteractionSettings, MomentsNumericKey>;
    if (numeric.maxPostIntervalHours < numeric.minPostIntervalHours) {
        numeric.maxPostIntervalHours = numeric.minPostIntervalHours;
    }
    const disabled = Array.isArray(src.disabledPosterIds)
        ? [...new Set(src.disabledPosterIds.filter((id): id is string => typeof id === 'string' && id.length > 0))]
        : [];
    return {
        autoPostEnabled: src.autoPostEnabled === true,
        disabledPosterIds: disabled,
        ...numeric,
    };
}

/** 這個角色／NPC 會不會自動發帖：總開關開著、而且沒被單獨關掉。 */
export function canAutoPost(settings: MomentsInteractionSettings, posterId: string): boolean {
    return settings.autoPostEnabled && !settings.disabledPosterIds.includes(posterId);
}

/** 改一個數值欄位，順帶維持「最短 ≤ 最長」：拉最短超過最長時把最長推上去，反之亦然。 */
export function setMomentsNumber(
    settings: MomentsInteractionSettings,
    key: MomentsNumericKey,
    value: number,
): MomentsInteractionSettings {
    const next = { ...settings, [key]: clampTo(key, value) };
    if (key === 'minPostIntervalHours' && next.maxPostIntervalHours < next.minPostIntervalHours) {
        next.maxPostIntervalHours = next.minPostIntervalHours;
    }
    if (key === 'maxPostIntervalHours' && next.minPostIntervalHours > next.maxPostIntervalHours) {
        next.minPostIntervalHours = next.maxPostIntervalHours;
    }
    return next;
}
