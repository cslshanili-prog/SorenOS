/**
 * 羈絆 App 的淺色／深色（plans/bond-look.md）。偏好只是這台裝置怎麼看，存 localStorage，不進備份、不上雲。
 * 「跟著手機」看系統的 prefers-color-scheme；系統主題（OSTheme.darkMode）開著也算深色。
 */

export type BondThemePref = 'system' | 'light' | 'dark';
export type BondThemeMode = 'light' | 'dark';

export const BOND_THEME_KEY = 'soren_bond_theme_v1';

export const BOND_THEME_LABEL: Record<BondThemePref, string> = { system: '跟著手機', light: '淺色', dark: '深色' };

export function resolveBondTheme(pref: BondThemePref, systemDark: boolean, osDark = false): BondThemeMode {
    if (pref === 'light' || pref === 'dark') return pref;
    return systemDark || osDark ? 'dark' : 'light';
}

export function readBondThemePref(): BondThemePref {
    try {
        const v = localStorage.getItem(BOND_THEME_KEY);
        return v === 'light' || v === 'dark' ? v : 'system';
    } catch {
        return 'system';
    }
}

const listeners = new Set<(p: BondThemePref) => void>();

export function writeBondThemePref(pref: BondThemePref): void {
    try {
        if (pref === 'system') localStorage.removeItem(BOND_THEME_KEY);
        else localStorage.setItem(BOND_THEME_KEY, pref);
    } catch { /* 存不了就只在這次有效 */ }
    listeners.forEach(fn => fn(pref));
}

export function onBondThemePref(fn: (p: BondThemePref) => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}
