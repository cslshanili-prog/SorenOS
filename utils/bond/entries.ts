/**
 * 羈絆的卡（片刻、隨筆…）的讀寫（plans/bond-batch2.md 1.1）。寫完更新登記表，
 * 再發 BOND_CHANGE_EVENT（帶 bondId），讓 OSContext 把相關角色的雲端狀態打髒——已收存的片刻、
 * 已收下的隨筆會進提示詞。
 */
import type { BondEntry } from '../../types';
import { DB } from '../db';
import { parseBondId } from './model';
import { allRegisteredBondEntries, dropBondEntriesFromRegistry, putBondEntriesInRegistry, setBondEntryRegistry } from './entryRegistry';
import { BOND_CHANGE_EVENT, type BondChangeDetail } from './store';

function announce(bondIds: string[]): void {
    const ids = [...new Set(bondIds.filter(Boolean))];
    if (typeof window === 'undefined' || !ids.length) return;
    window.dispatchEvent(new CustomEvent<BondChangeDetail>(BOND_CHANGE_EVENT, { detail: { ids } }));
}

export const newBondEntryId = (): string => `be-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

/** 讀全部並更新登記表（開機、還原備份後） */
export async function refreshBondEntryRegistry(): Promise<BondEntry[]> {
    const entries = await DB.getAllBondEntries().catch(() => [] as BondEntry[]);
    setBondEntryRegistry(entries);
    return entries;
}

/** 存好幾張（新的或改過的）；updatedAt 一律蓋成現在 */
export async function saveBondEntries(entries: BondEntry[]): Promise<BondEntry[]> {
    if (!entries.length) return [];
    const now = Date.now();
    const next = entries.map(e => ({ ...e, updatedAt: now }));
    await DB.saveBondEntries(next);
    putBondEntriesInRegistry(next);
    announce(next.map(e => e.bondId));
    return next;
}

export async function saveBondEntry(entry: BondEntry): Promise<BondEntry> {
    const [saved] = await saveBondEntries([entry]);
    return saved;
}

export async function deleteBondEntries(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const byId = new Map(allRegisteredBondEntries().map(e => [e.id, e]));
    const bondIds = ids.map(id => byId.get(id)?.bondId || '');
    await DB.deleteBondEntries(ids);
    dropBondEntriesFromRegistry(ids);
    announce(bondIds);
}

/**
 * 刪角色時：他所在的每段關係的卡。空間不一定存過（自動開的），所以照卡上的 bondId 拆開判斷，
 * 不靠 bonds 表。
 */
export async function deleteBondEntriesOfChar(charId: string): Promise<void> {
    const ids = allRegisteredBondEntries().filter(e => {
        const p = parseBondId(e.bondId);
        return !!p && (p.charId === charId || (p.kind === 'pair' && p.otherCharId === charId));
    }).map(e => e.id);
    await deleteBondEntries(ids);
}

/** 刪身份卡時：那張卡跟任何角色的卡 */
export async function deleteBondEntriesOfPersona(personaKey: string): Promise<void> {
    const ids = allRegisteredBondEntries().filter(e => {
        const p = parseBondId(e.bondId);
        return !!p && p.kind === 'persona' && p.personaKey === personaKey;
    }).map(e => e.id);
    await deleteBondEntries(ids);
}
