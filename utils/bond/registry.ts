/**
 * 羈絆空間的記憶體登記表（plans/bond.md 3.1）。提示詞是同步組的、讀不了 IndexedDB，
 * OSContext 開機和每次存改刪之後把整張 bonds 表放進來（跟行事曆的 setTripRegistry 同一個做法）。
 * 零依賴：提示詞那頭任何地方都能讀。
 */
import type { BondRecord, CharacterProfile } from '../../types';
import { bondIdForChar, pairBondId, personaBondId } from './model';

let __bonds = new Map<string, BondRecord>();
const listeners = new Set<() => void>();

export function setBondRegistry(records: BondRecord[]): void {
    __bonds = new Map(records.filter(b => b?.id).map(b => [b.id, b]));
    for (const fn of listeners) fn();
}

/** 單筆換掉（存完一筆時用，不用整張重讀） */
export function putBondInRegistry(record: BondRecord): void {
    const next = new Map(__bonds);
    next.set(record.id, record);
    __bonds = next;
    for (const fn of listeners) fn();
}

export function dropBondsFromRegistry(ids: string[]): void {
    if (!ids.length) return;
    const next = new Map(__bonds);
    for (const id of ids) next.delete(id);
    __bonds = next;
    for (const fn of listeners) fn();
}

export function onBondRegistryChange(fn: () => void): () => void {
    listeners.add(fn);
    return () => { listeners.delete(fn); };
}

export function allRegisteredBonds(): BondRecord[] {
    return [...__bonds.values()];
}

export function bondById(id: string | undefined | null): BondRecord | undefined {
    return id ? __bonds.get(id) : undefined;
}

/** 這張角色卡（可以是某條線的視圖）跟這條線上的你那段 */
export function bondForChar(char: Pick<CharacterProfile, 'id' | 'primaryPersonaKey'> | undefined | null): BondRecord | undefined {
    return char ? __bonds.get(bondIdForChar(char)) : undefined;
}

/** 某個角色跟某張身份卡 */
export function bondForPersona(charId: string, personaKey: string | undefined): BondRecord | undefined {
    return __bonds.get(personaBondId(charId, personaKey));
}

export function bondForPair(aId: string, bId: string): BondRecord | undefined {
    if (!aId || !bId || aId === bId) return undefined;
    return __bonds.get(pairBondId(aId, bId));
}
