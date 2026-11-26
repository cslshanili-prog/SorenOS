/**
 * 完成紀錄（bond_ledger）的記憶體登記表（plans/bond-batch4.md 1.3）。提示詞是同步組的，
 * 「等級、這期做了沒、連續幾天」要從這裡讀。OSContext 開機讀一次，之後每次寫都更新。零依賴。
 */
import type { BondLedgerRow } from '../../types';

let __byBond = new Map<string, BondLedgerRow[]>();
let __byId = new Map<string, BondLedgerRow>();
const listeners = new Set<() => void>();

function rebuild(rows: Iterable<BondLedgerRow>): void {
    const byBond = new Map<string, BondLedgerRow[]>();
    const byId = new Map<string, BondLedgerRow>();
    for (const r of rows) {
        if (!r?.id || !r.bondId) continue;
        byId.set(r.id, r);
        const list = byBond.get(r.bondId);
        if (list) list.push(r); else byBond.set(r.bondId, [r]);
    }
    __byBond = byBond;
    __byId = byId;
    for (const fn of listeners) fn();
}

export function setBondLedgerRegistry(rows: BondLedgerRow[]): void { rebuild(rows); }

export function putBondLedgerInRegistry(rows: BondLedgerRow[]): void {
    if (!rows.length) return;
    const next = new Map(__byId);
    for (const r of rows) next.set(r.id, r);
    rebuild(next.values());
}

export function dropBondLedgerFromRegistry(ids: string[]): void {
    if (!ids.length) return;
    const next = new Map(__byId);
    for (const id of ids) next.delete(id);
    rebuild(next.values());
}

export function onBondLedgerRegistryChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function bondLedgerOf(bondId: string | undefined | null): BondLedgerRow[] {
    return bondId ? (__byBond.get(bondId) || []) : [];
}

export function bondLedgerRowById(id: string): BondLedgerRow | undefined { return __byId.get(id); }

export function allRegisteredBondLedger(): BondLedgerRow[] { return [...__byId.values()]; }
