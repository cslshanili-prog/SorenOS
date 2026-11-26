/**
 * 心靈角落的紙條（plans/bond-batch3.md 1.3，紀要 3.8）。純邏輯，有測試。
 *
 * - bond_entries 的 note，text 是紙條內容。
 * - 投遞才算說出口：status 'published'＋deliveredAt。你的草稿只有你知道；角色的紙條生成完直接投遞。
 * - 收到的那方可以標「想再談／已回應／已說開」；有回應不等於說開。
 */
import type { BondEntry, BondSlip } from '../../types';
import { newBondEntryId } from './entries';

export const BUILTIN_SLIP_TAGS = ['吐槽', '掛念', '想一起做的事', '心結', '開心的事', '沒說出口的話'] as const;

export const SLIP_STATE_LABEL: Record<NonNullable<BondSlip['state']>, string> = {
    want_to_talk: '想再談', responded: '已回應', resolved: '已說開',
};

/** 標籤清單：內建＋這段關係自己加的（去重、保持順序） */
export function slipTagOptions(custom: string[] | undefined): string[] {
    const out: string[] = [];
    for (const t of [...BUILTIN_SLIP_TAGS, ...(custom || [])]) {
        const v = String(t || '').trim();
        if (v && !out.includes(v)) out.push(v);
    }
    return out;
}

export function newSlip(input: { bondId: string; author: 'user' | string; text: string; tags: string[]; replyTo?: string; now?: number }): BondEntry {
    const now = input.now ?? Date.now();
    return {
        id: newBondEntryId(),
        bondId: input.bondId,
        kind: 'note',
        author: input.author,
        text: input.text.trim(),
        eventDate: { precision: 'unknown' },
        writtenAt: now,
        sources: [],
        links: input.replyTo ? [{ type: 'entry', id: input.replyTo }] : [],
        status: 'draft',
        createdBy: input.author === 'user' ? 'user' : 'ai',
        slip: { tags: [...new Set(input.tags.map(t => t.trim()).filter(Boolean))], ...(input.replyTo ? { replyTo: input.replyTo } : {}) },
        updatedAt: now,
    };
}

/** 投遞（只有草稿能投；投過的不變） */
export function deliverSlip(e: BondEntry, now = Date.now()): BondEntry {
    if (e.kind !== 'note' || e.status === 'published') return e;
    return { ...e, status: 'published', writtenAt: now, slip: { ...(e.slip || { tags: [] }), deliveredAt: now }, updatedAt: now };
}

/** 收到的那方標狀態（null＝取消標記） */
export function setSlipState(e: BondEntry, state: BondSlip['state'] | null, now = Date.now()): BondEntry {
    const slip = { ...(e.slip || { tags: [] }) };
    if (state) slip.state = state; else delete slip.state;
    return { ...e, slip, updatedAt: now };
}

export function markSlipSeen(e: BondEntry, now = Date.now()): BondEntry {
    if (e.slip?.seenAt) return e;
    return { ...e, slip: { ...(e.slip || { tags: [] }), seenAt: now }, updatedAt: now };
}

export const slipDelivered = (e: BondEntry): boolean => e.kind === 'note' && e.status === 'published';

/** 角色丟來、你還沒讀的 */
export const slipUnreadByUser = (e: BondEntry): boolean => slipDelivered(e) && e.author !== 'user' && !e.slip?.seenAt;

/** 回在這張下面的（已投遞的；草稿只有作者看得到，由呼叫端決定要不要帶） */
export function slipReplies(entries: BondEntry[], id: string, includeDraftsOf?: string): BondEntry[] {
    return entries
        .filter(e => e.kind === 'note' && e.slip?.replyTo === id && (e.status === 'published' || (includeDraftsOf && e.author === includeDraftsOf)))
        .sort((a, b) => (a.slip?.deliveredAt || a.writtenAt) - (b.slip?.deliveredAt || b.writtenAt));
}

/** 信箱：最上層的紙條（不是回應的），新到舊；你的草稿也列（標草稿） */
export function slipInbox(entries: BondEntry[]): BondEntry[] {
    return entries
        .filter(e => e.kind === 'note' && !e.slip?.replyTo && (e.status === 'published' || e.author === 'user'))
        .sort((a, b) => (b.slip?.deliveredAt || b.writtenAt) - (a.slip?.deliveredAt || a.writtenAt));
}
