/**
 * 完成紀錄的讀寫（plans/bond-batch4.md 1.3）。寫完更新登記表；有分數變動的再發 BOND_CHANGE_EVENT，
 * 讓雲端那份提示詞（等級、這期做了沒）跟著重傳。事實（0 分）不打髒，免得每天傳好幾次。
 */
import type { BondLedgerRow } from '../../types';
import { DB } from '../db';
import { parseBondId } from './model';
import { allRegisteredBondLedger, bondLedgerRowById, dropBondLedgerFromRegistry, putBondLedgerInRegistry, setBondLedgerRegistry } from './ledgerRegistry';
import { BOND_CHANGE_EVENT, type BondChangeDetail } from './events';

function announce(bondIds: string[]): void {
    const ids = [...new Set(bondIds.filter(Boolean))];
    if (typeof window === 'undefined' || !ids.length) return;
    window.dispatchEvent(new CustomEvent<BondChangeDetail>(BOND_CHANGE_EVENT, { detail: { ids } }));
}

export async function refreshBondLedgerRegistry(): Promise<BondLedgerRow[]> {
    const rows = await DB.getAllBondLedger().catch(() => [] as BondLedgerRow[]);
    setBondLedgerRegistry(rows);
    return rows;
}

export async function saveBondLedgerRows(rows: BondLedgerRow[]): Promise<void> {
    if (!rows.length) return;
    await DB.saveBondLedgerRows(rows);
    putBondLedgerInRegistry(rows);
    announce(rows.filter(r => r.points || bondLedgerRowById(r.id)?.points).map(r => r.bondId));
}

export async function deleteBondLedgerRows(ids: string[]): Promise<void> {
    if (!ids.length) return;
    const bondIds = ids.map(id => bondLedgerRowById(id)?.bondId || '');
    await DB.deleteBondLedgerRows(ids);
    dropBondLedgerFromRegistry(ids);
    announce(bondIds);
}

/** 撤銷／恢復一筆（留著看得到「撤銷了」） */
export async function setLedgerRevoked(id: string, revoked: boolean): Promise<void> {
    const row = bondLedgerRowById(id);
    if (!row) return;
    const next: BondLedgerRow = { ...row };
    if (revoked) next.revokedAt = Date.now(); else delete next.revokedAt;
    await saveBondLedgerRows([next]);
}

export async function deleteBondLedgerOfChar(charId: string): Promise<void> {
    const ids = allRegisteredBondLedger().filter(r => {
        const p = parseBondId(r.bondId);
        return !!p && (p.charId === charId || (p.kind === 'pair' && p.otherCharId === charId));
    }).map(r => r.id);
    await deleteBondLedgerRows(ids);
}

export async function deleteBondLedgerOfPersona(personaKey: string): Promise<void> {
    const ids = allRegisteredBondLedger().filter(r => {
        const p = parseBondId(r.bondId);
        return !!p && p.kind === 'persona' && p.personaKey === personaKey;
    }).map(r => r.id);
    await deleteBondLedgerRows(ids);
}
