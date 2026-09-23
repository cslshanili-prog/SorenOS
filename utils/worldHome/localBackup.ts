/**
 * 家園存在 localStorage 裡的本機配置（隨「設置 → 導出/導入備份」一起帶走）：
 *   - world_home_api：家園全局 API（所有世界共用的覆蓋）
 *   - world_custom_styles：用戶收藏的自定義文風（跨世界複用）
 * 這兩份不在 IndexedDB，所以必須單獨走備份，否則換設備 / 導入後會丟。
 */
export const WORLD_API_KEY = 'world_home_api';
export const WORLD_CUSTOM_STYLE_KEY = 'world_custom_styles';

export function exportWorldHomeLocal(): Record<string, string> | undefined {
    try {
        const out: Record<string, string> = {};
        const api = localStorage.getItem(WORLD_API_KEY); if (api) out[WORLD_API_KEY] = api;
        const styles = localStorage.getItem(WORLD_CUSTOM_STYLE_KEY); if (styles) out[WORLD_CUSTOM_STYLE_KEY] = styles;
        return Object.keys(out).length ? out : undefined;
    } catch { return undefined; }
}

export function importWorldHomeLocal(data: Record<string, string> | null | undefined): void {
    if (!data || typeof data !== 'object') return;
    try {
        if (typeof data[WORLD_API_KEY] === 'string') localStorage.setItem(WORLD_API_KEY, data[WORLD_API_KEY]);
        if (typeof data[WORLD_CUSTOM_STYLE_KEY] === 'string') localStorage.setItem(WORLD_CUSTOM_STYLE_KEY, data[WORLD_CUSTOM_STYLE_KEY]);
    } catch { /* ignore */ }
}
