/**
 * 羈絆空間的讀寫（plans/bond-batch1.md 1.1）。寫完同步更新登記表，再發 BOND_CHANGE_EVENT
 * 讓 OSContext 打髒雲端（路線、此刻的我們都會進提示詞）。
 */
import type { BondOpenVia, BondRecord } from '../../types';
import { isBondOpen, planOpenMigration, withOpenState } from './openState';
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

// ─── 空間開了才有（plans/bond-open-spaces.md） ─────────────────

/** 開一個空間（已經開著就不動）；回傳開了沒、是不是這次才開的 */
export async function ensureSpaceOpen(id: string, via: BondOpenVia): Promise<{ record: BondRecord; opened: boolean }> {
    const cur = bondOrBlank(id);
    if (isBondOpen(cur)) return { record: cur, opened: false };
    const reopen = cur.openState?.state === 'closed';
    const record = await saveBondRecord(withOpenState({
        ...cur,
        ...(cur.openedBy === 'auto' && !reopen ? { openedBy: via === 'invite' ? 'char' as const : 'user' as const, openedAt: Date.now() } : {}),
    }, 'open', reopen ? 'reopen' : via));
    return { record, opened: true };
}

/** 收起：資料留著、背景停掉 */
export async function closeSpace(id: string): Promise<void> {
    await updateBond(id, b => withOpenState(b, 'closed', b.openState?.via || 'user'));
}

/** 刪掉這筆空間紀錄（卡片、帳本、親近信任由呼叫的地方先刪） */
export async function deleteBondRecord(id: string): Promise<void> {
    await DB.deleteBonds([id]);
    dropBondsFromRegistry([id]);
    announce([id]);
}

/** 開機時：還沒有 openState 的舊空間，有內容的記成開著（idempotent，還原舊備份後再跑也對） */
export async function migrateOpenStates(input: { entryBondIds: Map<string, number>; diaryCount: (id: string) => number }): Promise<number> {
    const plan = planOpenMigration({
        bonds: allRegisteredBonds(),
        orphanIds: [...input.entryBondIds.keys()],
        counts: id => ({ entries: input.entryBondIds.get(id) || 0, diaries: input.diaryCount(id) }),
        blank: id => blankBond(id),
    });
    for (const b of plan) {
        await DB.saveBond(b);
        putBondInRegistry(b);
    }
    if (plan.length) announce(plan.map(b => b.id));
    return plan.length;
}
