/**
 * 編修、撤回時各處對得上（plans/bond-batch2.md 1.3，紀要 4.2）。純邏輯，有測試。
 *
 * 每張卡的 links 記它「建在什麼上面」（隨筆 → 片刻／記憶；後記 → 原隨筆用 afterwordOf）。
 * 刪掉一件事前先列出依賴它的卡，讓你選「一起刪」或「留著、拆掉關聯」；拆掉的卡標 orphanedLinks，
 * 卡片上寫「原本關聯的那件事已刪除」，不悄悄消失。
 *
 * 第 2 批沒有寫進記憶宮殿的衍生物，撤回只動 bond_entries。第 6 批「讓 AI 寫他們的故事」：一章回寫出來的卡
 * 來源記這一章（`{ type: 'story' }`），寫到卡片以外的（話題盒 topic、記憶宮殿 palaceNode）記在 `story.derived`；
 * 刪改一章照 `storyDerivatives` 列出來（plans/bond-batch6.md 第 7 節）。
 */
import type { BondEntry, BondLink, BondSyncProposal } from '../../types';

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

// ─── 角色之間：一章故事長出來的東西（plans/bond-batch6.md 第 7 節） ───────────

const fromStory = (e: BondEntry, storyId: string) => e.sources.some(s => s.type === 'story' && s.entryId === storyId);

export interface StoryDerivatives {
    /** 來源記這一章的卡（片刻、里程碑、願望、約定、默契、禮物、信、日記） */
    entries: BondEntry[];
    /** 再往下建在那些卡上的（隨筆、後記…） */
    dependents: BondEntry[];
    topics: Array<{ charId: string; topicId: string }>;
    palace: Array<{ charId: string; nodeId: string }>;
    /** 還沒按的承認卡 */
    proposals: BondSyncProposal[];
}

export function storyDerivatives(entries: BondEntry[], story: BondEntry, pending: BondSyncProposal[] = []): StoryDerivatives {
    const direct = entries.filter(e => e.id !== story.id && fromStory(e, story.id));
    const seen = new Set(direct.map(e => e.id));
    const dependents: BondEntry[] = [];
    for (const d of direct) {
        for (const x of dependentsOf(entries, { type: 'entry', id: d.id })) {
            if (seen.has(x.id) || x.id === story.id) continue;
            seen.add(x.id);
            dependents.push(x);
        }
    }
    return {
        entries: direct, dependents,
        topics: story.story?.derived?.topics || [],
        palace: story.story?.derived?.palace || [],
        proposals: pending.filter(p => p.evidence.storyId === story.id),
    };
}

/** 拿掉一張卡上「來自這一章」的來源，標成原本關聯的那件事已刪除 */
export function detachFromStory(e: BondEntry, storyId: string, now = Date.now()): BondEntry {
    return {
        ...e,
        sources: e.sources.filter(s => !(s.type === 'story' && s.entryId === storyId)),
        orphanedLinks: [...(e.orphanedLinks || []), { type: 'entry', id: storyId }],
        updatedAt: now,
    };
}

/**
 * 刪一章：
 * - 'cascade'：連同長出來的卡和依賴它們的卡一起刪；同一件事另有有效來源（不只這一章）的卡留著、只拆關聯；
 * - 'detach'：卡都留著，拆掉跟這章的關聯（卡片上寫「原本關聯的那件事已刪除」）。
 * 這一章本身一律刪。話題盒與記憶宮殿由 App 那半照 derivatives 處理。
 */
export function planStoryRetract(entries: BondEntry[], story: BondEntry, mode: 'cascade' | 'detach', now = Date.now()): RetractPlan {
    const d = storyDerivatives(entries, story);
    if (mode === 'detach') return { deleteIds: [story.id], updates: d.entries.map(e => detachFromStory(e, story.id, now)) };
    const keep = d.entries.filter(e => e.sources.some(s => !(s.type === 'story' && s.entryId === story.id)));
    const keepIds = new Set(keep.map(e => e.id));
    const del = [...d.entries.filter(e => !keepIds.has(e.id)), ...d.dependents.filter(e => !keepIds.has(e.id))].map(e => e.id);
    return { deleteIds: [story.id, ...new Set(del)], updates: keep.map(e => detachFromStory(e, story.id, now)) };
}

/** 重新整理回寫前，刪掉你勾的那幾張（連同建在上面的卡）；同一件事另有來源的只拆關聯 */
export function planDerivedRemoval(entries: BondEntry[], story: BondEntry, ids: string[], now = Date.now()): RetractPlan {
    const pick = entries.filter(e => ids.includes(e.id) && fromStory(e, story.id));
    const keep = pick.filter(e => e.sources.some(s => !(s.type === 'story' && s.entryId === story.id)));
    const keepIds = new Set(keep.map(e => e.id));
    const del = new Set<string>();
    for (const e of pick) {
        if (keepIds.has(e.id)) continue;
        del.add(e.id);
        dependentsOf(entries, { type: 'entry', id: e.id }).forEach(x => { if (x.id !== story.id) del.add(x.id); });
    }
    return { deleteIds: [...del], updates: keep.map(e => detachFromStory(e, story.id, now)) };
}
