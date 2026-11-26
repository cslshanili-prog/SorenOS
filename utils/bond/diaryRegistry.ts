/**
 * 日記的記憶體登記表（plans/bond-batch3.md 第 2 節）：提示詞是同步組的，「你們的日記」要從這裡讀。
 * DB.saveDiary／deleteDiary 會順手更新；OSContext 開機時讀一次（順便替舊日記補上 bondId，見 utils/bond/diaryStore.ts）。
 * 零依賴：db.ts 和提示詞那頭都能 import。
 */
import type { DiaryEntry } from '../../types';
import { announceBondChange } from './events';

let __byId = new Map<string, DiaryEntry>();
let __byBond = new Map<string, DiaryEntry[]>();

function rebuild(): void {
    const byBond = new Map<string, DiaryEntry[]>();
    for (const d of __byId.values()) {
        if (!d.bondId) continue;
        const list = byBond.get(d.bondId);
        if (list) list.push(d); else byBond.set(d.bondId, [d]);
    }
    __byBond = byBond;
}

export function setDiaryRegistry(all: DiaryEntry[]): void {
    __byId = new Map(all.filter(d => d?.id).map(d => [d.id, d]));
    rebuild();
}

/** 存了一本（db.ts 呼叫）；這本掛在哪段關係就打髒那段 */
export function putDiaryInRegistry(d: DiaryEntry): void {
    const prev = __byId.get(d.id);
    __byId.set(d.id, d);
    rebuild();
    announceBondChange([d.bondId, prev?.bondId]);
}

export function dropDiaryFromRegistry(id: string): void {
    const prev = __byId.get(id);
    if (!prev) return;
    __byId.delete(id);
    rebuild();
    announceBondChange([prev.bondId]);
}

/** 這段關係的日記（沒有 bondId 的舊日記開機時已補上；還沒補的不算） */
export function diariesOfBondSync(bondId: string | undefined | null): DiaryEntry[] {
    return bondId ? (__byBond.get(bondId) || []) : [];
}
