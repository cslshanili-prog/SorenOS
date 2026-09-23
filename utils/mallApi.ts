import type { APIConfig } from '../types';
import { normalizeApiConfig } from './apiConfigNormalize';

const STORAGE_KEY = 'mall_api';

/** 購物中心 AI 補貨獨立 API；null 表示跟隨聊天默認。跟 utils/checkPhoneApi.ts 同一個路數。 */
export function getMallApi(): APIConfig | null {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return null;
        const parsed = normalizeApiConfig(JSON.parse(raw) as APIConfig);
        return parsed.baseUrl ? parsed : null;
    } catch {
        return null;
    }
}

export function setMallApi(config: APIConfig | null): void {
    try {
        if (!config?.baseUrl) localStorage.removeItem(STORAGE_KEY);
        else localStorage.setItem(STORAGE_KEY, JSON.stringify(normalizeApiConfig(config)));
        window.dispatchEvent(new CustomEvent('mall-api-changed'));
    } catch { /* localStorage may be unavailable in private/restricted contexts */ }
}

export function resolveMallApi(independent: APIConfig | null, chatDefault: APIConfig): APIConfig {
    return independent?.baseUrl ? independent : chatDefault;
}
