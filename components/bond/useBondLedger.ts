/** 一段關係的完成紀錄（plans/bond-batch4.md 1.3），跟著登記表即時更新 */
import { useEffect, useState } from 'react';
import type { BondLedgerRow } from '../../types';
import { bondLedgerOf, onBondLedgerRegistryChange } from '../../utils/bond/ledgerRegistry';

export function useBondLedger(bondId: string): BondLedgerRow[] {
    const [rows, setRows] = useState<BondLedgerRow[]>(() => bondLedgerOf(bondId));
    useEffect(() => {
        setRows(bondLedgerOf(bondId));
        return onBondLedgerRegistryChange(() => setRows(bondLedgerOf(bondId)));
    }, [bondId]);
    return rows;
}
