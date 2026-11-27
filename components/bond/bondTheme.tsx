/**
 * 羈絆 App 的淺色／深色外層（plans/bond-look.md）：偏好在 utils/bond/theme.ts，這裡接上系統的
 * prefers-color-scheme，掛 data-bond-theme 讓 bondUi 的深色變數生效。
 */
import React, { useEffect, useState } from 'react';
import { onBondThemePref, readBondThemePref, resolveBondTheme, type BondThemeMode, type BondThemePref } from '../../utils/bond/theme';

const darkQuery = () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null);

export function useBondThemePref(): BondThemePref {
    const [pref, setPref] = useState<BondThemePref>(readBondThemePref);
    useEffect(() => onBondThemePref(setPref), []);
    return pref;
}

export function useBondTheme(osDark = false): BondThemeMode {
    const pref = useBondThemePref();
    const [systemDark, setSystemDark] = useState(() => !!darkQuery()?.matches);
    useEffect(() => {
        const q = darkQuery();
        if (!q) return;
        const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
        q.addEventListener?.('change', on);
        return () => q.removeEventListener?.('change', on);
    }, []);
    return resolveBondTheme(pref, systemDark, osDark);
}

export const BondThemeRoot: React.FC<{ osDark?: boolean; children: React.ReactNode }> = ({ osDark, children }) => {
    const mode = useBondTheme(!!osDark);
    return <div className="h-full w-full" data-bond-theme={mode}>{children}</div>;
};
