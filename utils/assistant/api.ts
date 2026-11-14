/**
 * Sore 用哪組 API（plans/ai-assistant.md：設定裡可選，預設用副 API）。
 * - auto：副 API（記憶宮殿那組 lightLLM）有設就用，不然用全域
 * - global：全域那組
 * - preset:<id>：API 庫裡的某一組
 * 偏好存在這台裝置（localStorage），跟備份無關。
 */
import type { ApiPreset, APIConfig } from '../../types';

export type SoreApiSource = 'auto' | 'global' | `preset:${string}`;

export interface SoreApi {
    baseUrl: string;
    apiKey: string;
    model: string;
    /** 給畫面顯示：用的是哪一組 */
    label: string;
}

const PREFS_KEY = 'soren_assistant_prefs_v1';

export interface SorePrefs {
    apiSource: SoreApiSource;
}

export const loadSorePrefs = (): SorePrefs => {
    try {
        const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}');
        const source = typeof raw.apiSource === 'string' ? raw.apiSource : 'auto';
        return { apiSource: (source === 'global' || source.startsWith('preset:') ? source : 'auto') as SoreApiSource };
    } catch {
        return { apiSource: 'auto' };
    }
};

export const saveSorePrefs = (prefs: SorePrefs) => {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* 存不了就算了 */ }
};

const usable = (c: Partial<APIConfig> | undefined): c is APIConfig => !!(c?.baseUrl?.trim() && c.model?.trim());

/** 照偏好挑一組；挑的那組不能用就往下退（API 庫那組被刪了 → 自動），都不能用回 null */
export const resolveSoreApi = (
    source: SoreApiSource,
    input: { apiConfig: APIConfig; lightLLM?: Partial<APIConfig>; apiPresets?: ApiPreset[] },
): SoreApi | null => {
    const pick = (c: Partial<APIConfig>, label: string): SoreApi => ({ baseUrl: c.baseUrl!, apiKey: c.apiKey || '', model: c.model!, label });
    if (source.startsWith('preset:')) {
        const preset = input.apiPresets?.find(p => p.id === source.slice('preset:'.length));
        if (preset && usable(preset.config)) return pick(preset.config, `API 庫 · ${preset.name}`);
    }
    if (source === 'global') {
        if (usable(input.apiConfig)) return pick(input.apiConfig, '全域 API');
    }
    if (usable(input.lightLLM)) return pick(input.lightLLM, '副 API');
    if (usable(input.apiConfig)) return pick(input.apiConfig, '全域 API');
    return null;
};
