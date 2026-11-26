/**
 * 羈絆空間的讀寫（plans/bond-batch1.md 1.1）。寫完同步更新登記表，再發 BOND_CHANGE_EVENT
 * 讓 OSContext 打髒雲端（路線、此刻的我們都會進提示詞）。
 */
import type { BondRecord } from '../../types';
import { DB } from '../db';
import { blankBond } from './model';
import { allRegisteredBonds, bondById, dropBondsFromRegistry, putBondInRegistry, setBondRegistry } from './registry';

import { BOND_CHANGE_EVENT, type BondChangeDetail } from './events';
export { BOND_CHANGE_EVENT, type BondChangeDetail } from './events';

function announce(ids: string[]): void {
    if (typeof window === 'undefined' || !ids.length) return;
    window.dispatchEvent(new CustomEvent<BondChangeDetail>(BOND_CHANGE_EVENT, { detail: { ids } }));
}

/** 讀全部並更新登記表（開機、還原備份後） */
export async function refreshBondRegistry(): Promise<BondRecord[]> {
    const bonds = await DB.getAllBonds().catch(() => [] as BondRecord[]);
    setBondRegistry(bonds);
    return bonds;
}

/** 存一筆（新的或改過的） */
export async function saveBondRecord(bond: BondRecord): Promise<BondRecord> {
    const next = { ...bond, updatedAt: Date.now() };
    await DB.saveBond(next);
    putBondInRegistry(next);
    announce([next.id]);
    return next;
}

/** 讀一段：表裡有就回它，沒有回一筆還沒存的預設（自動開啟的空間） */
export function bondOrBlank(id: string): BondRecord {
    return bondById(id) || blankBond(id);
}

/** 改一段：沒存過的先用預設補齊再改 */
export async function updateBond(id: string, patch: (cur: BondRecord) => BondRecord): Promise<BondRecord> {
    const next = patch(bondOrBlank(id));
    return saveBondRecord(next);
}

/** 刪角色時：他所有的空間（身份卡 × 他、他 × 任何角色） */
export async function deleteBondsOfChar(charId: string): Promise<void> {
    const ids = allRegisteredBonds().filter(b => b.charId === charId || b.otherCharId === charId).map(b => b.id);
    if (!ids.length) return;
    await DB.deleteBonds(ids);
    dropBondsFromRegistry(ids);
    announce(ids);
}

/** 刪身份卡時：那張卡的空間 */
export async function deleteBondsOfPersona(personaKey: string): Promise<void> {
    const ids = allRegisteredBonds().filter(b => b.kind === 'persona' && b.personaKey === personaKey).map(b => b.id);
    if (!ids.length) return;
    await DB.deleteBonds(ids);
    dropBondsFromRegistry(ids);
    announce(ids);
}
