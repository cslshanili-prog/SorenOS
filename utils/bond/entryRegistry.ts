/**
 * 羈絆的卡（bond_entries）的記憶體登記表（plans/bond-batch2.md）。提示詞是同步組的，
 * 「最近收存的片刻、你寫過的隨筆」要從這裡讀。OSContext 開機讀一次，之後每次存刪都更新。
 * 零依賴：提示詞那頭任何地方都能讀。
 */
import type { BondEntry } from '../../types';

let __byBond = new Map<string, BondEntry[]>();
let __byId = new Map<string, BondEntry>();
const listeners = new Set<() => void>();

function rebuild(entries: Iterable<BondEntry>): void {
    const byBond = new Map<string, BondEntry[]>();
    const byId = new Map<string, BondEntry>();
    for (const e of entries) {
        if (!e?.id || !e.bondId) continue;
        byId.set(e.id, e);
        const list = byBond.get(e.bondId);
        if (list) list.push(e); else byBond.set(e.bondId, [e]);
    }
    __byBond = byBond;
    __byId = byId;
    for (const fn of listeners) fn();
}

export function setBondEntryRegistry(entries: BondEntry[]): void {
    rebuild(entries);
}

export function putBondEntriesInRegistry(entries: BondEntry[]): void {
    if (!entries.length) return;
    const next = new Map(__byId);
    for (const e of entries) next.set(e.id, e);
    rebuild(next.values());
}

export function dropBondEntriesFromRegistry(ids: string[]): void {
    if (!ids.length) return;
    const next = new Map(__byId);
    for (const id of ids) next.delete(id);
    rebuild(next.values());
}

export function onBondEntryRegistryChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function bondEntriesOf(bondId: string | undefined | null): BondEntry[] {
    return bondId ? (__byBond.get(bondId) || []) : [];
}

export function bondEntryById(id: string | undefined | null): BondEntry | undefined {
    return id ? __byId.get(id) : undefined;
}

export function allRegisteredBondEntries(): BondEntry[] {
    return [...__byId.values()];
}
