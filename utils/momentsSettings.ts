import type { MomentsInteractionSettings } from '../types';

/** 各數值欄位的範圍與步進，設定頁的滑桿和 normalize 共用這一份。 */
export const MOMENTS_SETTING_RANGES = {
    minPostIntervalHours: { min: 1, max: 168, step: 1 },
    maxPostIntervalHours: { min: 1, max: 168, step: 1 },
    commentProbability: { min: 0, max: 100, step: 5 },
    likeProbability: { min: 0, max: 100, step: 5 },
    supportingMinPostIntervalHours: { min: 1, max: 336, step: 1 },
    supportingMaxPostIntervalHours: { min: 1, max: 336, step: 1 },
    supportingCommentProbability: { min: 0, max: 100, step: 5 },
    supportingLikeProbability: { min: 0, max: 100, step: 5 },
    firstCommentDelaySec: { min: 0, max: 600, step: 10 },
    commentIntervalSec: { min: 0, max: 600, step: 10 },
    supportingInteractionDelayMin: { min: 0, max: 180, step: 5 },
    replyToSupportingDelaySec: { min: 0, max: 120, step: 1 },
} as const;

export type MomentsNumericKey = keyof typeof MOMENTS_SETTING_RANGES;

export const DEFAULT_MOMENTS_SETTINGS: MomentsInteractionSettings = {
    autoPostEnabled: false,
    disabledPosterIds: [],
    minPostIntervalHours: 48,
    maxPostIntervalHours: 72,
    commentProbability: 40,
    likeProbability: 75,
    // 配角：發文間隔拉長一倍多、留言和按讚機率低一點（Liora 2026-11-26：配角大概發文機率都會較低一點）
    supportingMinPostIntervalHours: 96,
    supportingMaxPostIntervalHours: 168,
    supportingCommentProbability: 20,
    supportingLikeProbability: 50,
    firstCommentDelaySec: 120,
    commentIntervalSec: 60,
    supportingInteractionDelayMin: 30,
    replyToSupportingDelaySec: 3,
};

const clampTo = (key: MomentsNumericKey, value: unknown): number => {
    const { min, max } = MOMENTS_SETTING_RANGES[key];
    const n = typeof value === 'number' && Number.isFinite(value) ? value : DEFAULT_MOMENTS_SETTINGS[key];
    return Math.min(max, Math.max(min, Math.round(n)));
};

/** 讀存檔：缺的補預設、超出範圍的夾回來、最長間隔不小於最短間隔、poster 清單去重。 */
/** 舊存檔的 NPC 那組 → 配角那組（NPC 搬成配角後，同一組人照舊用同一組值；新的那格有值就聽新的） */
const LEGACY_NPC_KEYS: Partial<Record<MomentsNumericKey, string>> = {
    supportingCommentProbability: 'npcCommentProbability',
    supportingLikeProbability: 'npcLikeProbability',
    supportingInteractionDelayMin: 'npcInteractionDelayMin',
    replyToSupportingDelaySec: 'replyToNpcDelaySec',
};

export function normalizeMomentsSettings(raw: Partial<MomentsInteractionSettings> | undefined | null): MomentsInteractionSettings {
    const legacy = (raw || {}) as Record<string, unknown>;
    const src: Partial<MomentsInteractionSettings> = { ...(raw || {}) };
    for (const [key, oldKey] of Object.entries(LEGACY_NPC_KEYS) as Array<[MomentsNumericKey, string]>) {
        if (src[key] === undefined && typeof legacy[oldKey] === 'number') (src as Record<string, unknown>)[key] = legacy[oldKey];
    }
    const numeric = Object.fromEntries(
        (Object.keys(MOMENTS_SETTING_RANGES) as MomentsNumericKey[]).map(key => [key, clampTo(key, src[key])]),
    ) as Pick<MomentsInteractionSettings, MomentsNumericKey>;
    if (numeric.maxPostIntervalHours < numeric.minPostIntervalHours) {
        numeric.maxPostIntervalHours = numeric.minPostIntervalHours;
    }
    if (numeric.supportingMaxPostIntervalHours < numeric.supportingMinPostIntervalHours) {
        numeric.supportingMaxPostIntervalHours = numeric.supportingMinPostIntervalHours;
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

/** 這個角色會不會自動發帖：總開關開著、而且沒被單獨關掉。 */
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
    if (key === 'supportingMinPostIntervalHours' && next.supportingMaxPostIntervalHours < next.supportingMinPostIntervalHours) {
        next.supportingMaxPostIntervalHours = next.supportingMinPostIntervalHours;
    }
    if (key === 'supportingMaxPostIntervalHours' && next.supportingMinPostIntervalHours > next.supportingMaxPostIntervalHours) {
        next.supportingMinPostIntervalHours = next.supportingMaxPostIntervalHours;
    }
    return next;
}

/** 發文間隔照戲份挑：配角用配角那組（間隔長一點），主角用主角那組 */
export function postIntervalFor(
    settings: Pick<MomentsInteractionSettings, 'minPostIntervalHours' | 'maxPostIntervalHours' | 'supportingMinPostIntervalHours' | 'supportingMaxPostIntervalHours'>,
    supporting: boolean,
): { minPostIntervalHours: number; maxPostIntervalHours: number } {
    return supporting
        ? { minPostIntervalHours: settings.supportingMinPostIntervalHours, maxPostIntervalHours: settings.supportingMaxPostIntervalHours }
        : { minPostIntervalHours: settings.minPostIntervalHours, maxPostIntervalHours: settings.maxPostIntervalHours };
}
