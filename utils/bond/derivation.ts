/**
 * 編修、撤回時各處對得上（plans/bond-batch2.md 1.3，紀要 4.2）。純邏輯，有測試。
 *
 * 每張卡的 links 記它「建在什麼上面」（隨筆 → 片刻／記憶；後記 → 原隨筆用 afterwordOf）。
 * 刪掉一件事前先列出依賴它的卡，讓你選「一起刪」或「留著、拆掉關聯」；拆掉的卡標 orphanedLinks，
 * 卡片上寫「原本關聯的那件事已刪除」，不悄悄消失。
 *
 * 第 2 批沒有寫進記憶宮殿的衍生物，撤回只動 bond_entries；第 6 批「讓 AI 寫他們的故事」會產生記憶，
 * 到時在這裡加 palaceNode 類型的依賴，撤回時一起處理。
 */
import type { BondEntry, BondLink } from '../../types';

export type DerivationRef = { type: 'entry'; id: string } | { type: 'memory'; memoryId: string };

const linkMatches = (link: BondLink, ref: DerivationRef): boolean =>
    ref.type === 'entry' ? link.type === 'entry' && link.id === ref.id : link.type === 'memory' && link.memoryId === ref.memoryId;

/** 直接建在 ref 上的卡（不含它自己） */
export function directDependents(entries: BondEntry[], ref: DerivationRef): BondEntry[] {
    return entries.filter(e => (ref.type === 'entry' && e.id === ref.id ? false
        : e.links.some(l => linkMatches(l, ref)) || (ref.type === 'entry' && e.afterwordOf === ref.id)));
}

/** 一路往下所有依賴 ref 的卡（隨筆的後記的後記…） */
export function dependentsOf(entries: BondEntry[], ref: DerivationRef): BondEntry[] {
    const out = new Map<string, BondEntry>();
    const queue: DerivationRef[] = [ref];
    while (queue.length) {
        const cur = queue.shift()!;
        for (const e of directDependents(entries, cur)) {
            if (out.has(e.id) || (ref.type === 'entry' && e.id === ref.id)) continue;
            out.set(e.id, e);
            queue.push({ type: 'entry', id: e.id });
        }
    }
    return [...out.values()];
}

export interface RetractPlan {
    /** 要刪的卡 id（包含被刪的那張，若它本身是卡） */
    deleteIds: string[];
    /** 留下但要改（拆掉關聯）的卡 */
    updates: BondEntry[];
}

/**
 * 刪一件事時怎麼處理依賴它的卡：
 * - 'cascade'：連同所有依賴的卡一起刪；
 * - 'detach'：依賴的卡留著，把指向它的關聯移到 orphanedLinks（後記指向被刪的隨筆時也一樣，改成獨立一篇）。
 */
export function planRetract(entries: BondEntry[], ref: DerivationRef, mode: 'cascade' | 'detach', now = Date.now()): RetractPlan {
    const self = ref.type === 'entry' ? [ref.id] : [];
    if (mode === 'cascade') {
        return { deleteIds: [...self, ...dependentsOf(entries, ref).map(e => e.id)], updates: [] };
    }
    const updates = directDependents(entries, ref).map(e => {
        const gone = e.links.filter(l => linkMatches(l, ref));
        const orphanedAfterword: BondLink[] = ref.type === 'entry' && e.afterwordOf === ref.id ? [{ type: 'entry', id: ref.id }] : [];
        return {
            ...e,
            links: e.links.filter(l => !linkMatches(l, ref)),
            afterwordOf: ref.type === 'entry' && e.afterwordOf === ref.id ? undefined : e.afterwordOf,
            orphanedLinks: [...(e.orphanedLinks || []), ...gone, ...orphanedAfterword],
            updatedAt: now,
        };
    });
    return { deleteIds: self, updates };
}
