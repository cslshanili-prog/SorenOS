/** 羈絆改了的事件名（零依賴，db.ts 也能發，不會繞回 store.ts） */
export const BOND_CHANGE_EVENT = 'soren-bond-change';
export interface BondChangeDetail { ids: string[] }

export function announceBondChange(bondIds: Array<string | undefined | null>): void {
    const ids = [...new Set(bondIds.filter((x): x is string => !!x))];
    if (typeof window === 'undefined' || !ids.length) return;
    window.dispatchEvent(new CustomEvent<BondChangeDetail>(BOND_CHANGE_EVENT, { detail: { ids } }));
}
