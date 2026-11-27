/**
 * 羈絆空間「開了才有」（plans/bond-open-spaces.md）。純邏輯，有測試。
 *
 * - 以前每個角色對你認識的每張卡都自動算一個空間，名單很長、配角也在、背景功能對每一個都跑。
 * - 現在：你按＋開、角色邀請你答應、或你從聊天收存到羈絆，空間才開；開了才列出來、背景功能才跑。
 * - 收起：資料留著、背景停掉、名單上移到「收起的」；再開就回來。刪除另外走 store 的 deleteSpace。
 * - 舊資料搬遷：還沒有 openState 的紀錄，**有內容的算開著**（設過路線、寫過此刻的我們、加過天數起點、
 *   開始記親近信任、有卡片、有交換日記、寫過概覽…），其餘不算開（照樣留在表裡，等你哪天開）。
 */
import type { BondOpenVia, BondRecord } from '../../types';
import { isDefaultBondState } from './routes';

export const isBondOpen = (b: Pick<BondRecord, 'openState'> | undefined | null): boolean => b?.openState?.state === 'open';
export const isBondClosed = (b: Pick<BondRecord, 'openState'> | undefined | null): boolean => b?.openState?.state === 'closed';

export function withOpenState(b: BondRecord, state: 'open' | 'closed', via: BondOpenVia, now = Date.now()): BondRecord {
    return { ...b, openState: { state, at: now, via } };
}

/** 這段關係有沒有「你會想留著」的內容（搬遷用） */
export function bondHasContent(b: BondRecord, extra: { entries: number; diaries: number }): boolean {
    if (extra.entries > 0 || extra.diaries > 0) return true;
    if (!isDefaultBondState(b) || b.routeLog?.length) return true;
    if (b.ourNow?.user?.text || b.ourNow?.char?.text || b.ourNow?.other?.text) return true;
    if (b.days?.extra?.length || b.days?.metDate) return true;
    if (b.feeling) return true;
    if (b.openedBy === 'user' || b.openedBy === 'char') return true;
    if (b.output && Object.keys(b.output).length) return true;
    if (b.pairOverview || b.pairStoryPrefs) return true;
    if (b.memoryMarks && Object.keys(b.memoryMarks).length) return true;
    return false;
}

/**
 * 還沒有 openState 的空間，有內容的記成開著（via 'migrate'）。
 * ids 是「可能有空間」的全部 id：表裡的紀錄＋有卡片、有日記但表裡還沒紀錄的。回傳要存的紀錄。
 */
export function planOpenMigration(input: {
    bonds: BondRecord[];
    /** 表裡沒有紀錄、但有卡片或日記的 id（第一次寫卡時不寫 bonds 的那種） */
    orphanIds: string[];
    counts: (id: string) => { entries: number; diaries: number };
    blank: (id: string) => BondRecord;
    now?: number;
}): BondRecord[] {
    const now = input.now ?? Date.now();
    const out: BondRecord[] = [];
    const seen = new Set<string>();
    for (const b of input.bonds) {
        seen.add(b.id);
        if (b.openState) continue;
        if (bondHasContent(b, input.counts(b.id))) out.push(withOpenState(b, 'open', 'migrate', now));
    }
    for (const id of input.orphanIds) {
        if (seen.has(id)) continue;
        seen.add(id);
        const c = input.counts(id);
        if (c.entries > 0 || c.diaries > 0) out.push(withOpenState(input.blank(id), 'open', 'migrate', now));
    }
    return out;
}

/** 上次停留的空間（進 App 直接開它） */
export const LAST_SPACE_KEY = 'soren_bond_last_space_v1';
export function readLastSpace(): string | null {
    try { return localStorage.getItem(LAST_SPACE_KEY); } catch { return null; }
}
export function writeLastSpace(id: string): void {
    try { localStorage.setItem(LAST_SPACE_KEY, id); } catch { /* 存不了下次進來開最近的 */ }
}

/** 進 App 開哪一個：上次停留的（還開著）＞最近動過的開著的那個 */
export function pickHomeSpace(open: Array<Pick<BondRecord, 'id' | 'updatedAt' | 'openState'>>, last: string | null): string | null {
    if (last && open.some(b => b.id === last)) return last;
    const sorted = [...open].sort((a, b) => Math.max(b.updatedAt, b.openState?.at || 0) - Math.max(a.updatedAt, a.openState?.at || 0));
    return sorted[0]?.id || null;
}
