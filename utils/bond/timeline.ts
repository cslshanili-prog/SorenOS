/**
 * 拾光時間線怎麼組（plans/bond-batch2.md 1.2、第 4 節）。純邏輯，有測試。
 *
 * - 2026-11-28 改版（plans/bond-moments-v2.md）：拾光不再讀記憶；主體是從這條線的聊天、見面生成的片段
 *   （bond_entries 的 moment＋fragment），加上你收存的片刻、里程碑。memories／topics 兩個輸入留著給舊測試，
 *   App 不再傳。
 * - 隨筆不單獨占一列（「隨筆」篩選才列），掛在它寫的那件事底下算數量。
 * - 收藏、收起：片刻存在卡上；記憶存在 bonds.memoryMarks，不改記憶本身。
 */
import { milestoneLabel } from './pact';
import type { BondEntry, BondEventDate, BondRecord, CharacterProfile, ConvTopic, MemoryFragment, PhoneContact } from '../../types';
import { getLocalDateKey } from '../localDate';
import { eventDateFromText, eventSortKey } from './eventDate';

export type TimelineFilter = 'all' | 'moment' | 'milestone' | 'memory' | 'essay' | 'favorite';

export type TimelineRef =
    | { type: 'entry'; entry: BondEntry }
    | { type: 'memory'; charId: string; memory: MemoryFragment }
    | { type: 'topic'; ownerId: string; partnerId: string; topic: ConvTopic };

export interface TimelineItem {
    /** 'e:<entryId>' | 'm:<memoryId>' | 't:<ownerId>:<topicId>' */
    key: string;
    kind: 'moment' | 'memory' | 'essay' | 'milestone';
    eventDate: BondEventDate;
    sortKey: string;
    /** 同一天的先後（片刻用寫下時間；記憶照原本順序） */
    tieBreak: number;
    title?: string;
    text: string;
    favorite: boolean;
    hidden: boolean;
    /** 隨筆（含草稿、後記）裡關於這件事的 */
    essays: BondEntry[];
    ref: TimelineRef;
}

/**
 * 某條線的記憶：寫了 personaKey 的照卡分；沒寫的是主線的舊記憶，算在主線那張卡上。
 * 角色還沒有身份卡鍵（舊資料）時 personaKey 是 undefined，就收全部沒寫鍵的。
 */
export function memoriesForLine(memories: MemoryFragment[] | undefined, personaKey: string | undefined, primaryPersonaKey: string | undefined): MemoryFragment[] {
    const list = Array.isArray(memories) ? memories : [];
    const isMain = !personaKey || personaKey === primaryPersonaKey;
    return list.filter(m => (m.personaKey ? m.personaKey === personaKey : isMain));
}

const normName = (s: string | undefined) => String(s || '').trim().toLowerCase();

/** owner 通訊錄裡 partner 那一格（跟 utils/pairChatRun.ts 的 contactOf 同一個判斷，這裡不帶資料庫） */
export function contactFor(owner: Pick<CharacterProfile, 'phoneState'>, partner: Pick<CharacterProfile, 'id' | 'name'>): PhoneContact | undefined {
    return (owner.phoneState?.contacts || []).find(c => c.linkedCharId === partner.id || normName(c.name) === normName(partner.name));
}

/** 這張隨筆寫的是哪件事（時間線上那一列的 key）；後記跟著原隨筆走 */
export function essayTargetKey(essay: BondEntry, byId: Map<string, BondEntry>): string | undefined {
    let cur: BondEntry | undefined = essay;
    const seen = new Set<string>();
    while (cur?.afterwordOf && !seen.has(cur.id)) {
        seen.add(cur.id);
        cur = byId.get(cur.afterwordOf);
    }
    const link = cur?.links.find(l => l.type === 'entry' || l.type === 'memory');
    if (!link) return undefined;
    return link.type === 'entry' ? `e:${link.id}` : `m:${link.memoryId}`;
}

export interface BuildTimelineInput {
    bond: BondRecord | undefined;
    entries: BondEntry[];
    /** persona：這條線的記憶（memoriesForLine 篩過） */
    memories?: { charId: string; list: MemoryFragment[] };
    /** pair：雙方話題盒 */
    topics?: Array<{ ownerId: string; partnerId: string; list: ConvTopic[] }>;
}

export function buildTimeline(input: BuildTimelineInput): TimelineItem[] {
    const { bond, entries } = input;
    const marks = bond?.memoryMarks || {};
    const byId = new Map(entries.map(e => [e.id, e]));
    const essaysByKey = new Map<string, BondEntry[]>();
    for (const e of entries) {
        if (e.kind !== 'essay') continue;
        const key = essayTargetKey(e, byId);
        if (!key) continue;
        const list = essaysByKey.get(key);
        if (list) list.push(e); else essaysByKey.set(key, [e]);
    }
    const items: TimelineItem[] = [];
    for (const e of entries) {
        // 里程碑（plans/bond-batch4.md 1.5）跟片刻同一條路，類型另外標
        if (e.kind !== 'moment' && !(e.kind === 'milestone' && e.status === 'published')) continue;
        const key = `e:${e.id}`;
        items.push({
            key, kind: e.kind === 'milestone' ? 'milestone' : 'moment', eventDate: e.eventDate, sortKey: eventSortKey(e.eventDate), tieBreak: e.fragment?.at ?? e.writtenAt,
            title: e.kind === 'milestone' ? (e.title || milestoneLabel(e.milestone?.what || '')) : e.title, text: e.text, favorite: !!e.favorite, hidden: !!e.hidden,
            essays: essaysByKey.get(key) || [], ref: { type: 'entry', entry: e },
        });
    }
    if (input.memories) {
        input.memories.list.forEach((m, i) => {
            const key = `m:${m.id}`;
            const d = eventDateFromText(m.date);
            items.push({
                key, kind: 'memory', eventDate: d, sortKey: eventSortKey(d), tieBreak: i,
                text: m.summary, favorite: !!marks[m.id]?.favorite, hidden: !!marks[m.id]?.hidden,
                essays: essaysByKey.get(key) || [], ref: { type: 'memory', charId: input.memories!.charId, memory: m },
            });
        });
    }
    for (const side of input.topics || []) {
        for (const t of side.list) {
            // 故事回寫的那條是同一件事的記憶，時間線上已經有那一章長出來的片刻，不重複列
            if (t.storyId) continue;
            const key = `t:${side.ownerId}:${t.id}`;
            const d: BondEventDate = { precision: 'day', date: getLocalDateKey(new Date(t.createdAt)) };
            items.push({
                key, kind: 'memory', eventDate: d, sortKey: eventSortKey(d), tieBreak: t.createdAt,
                text: t.text, favorite: !!marks[t.id]?.favorite, hidden: !!marks[t.id]?.hidden,
                essays: essaysByKey.get(`m:${t.id}`) || [], ref: { type: 'topic', ownerId: side.ownerId, partnerId: side.partnerId, topic: t },
            });
        }
    }
    return sortTimeline(items);
}

/** 新的在前；同一天照寫下先後（後寫的在前） */
export function sortTimeline<T extends { sortKey: string; tieBreak: number }>(items: T[]): T[] {
    return [...items].sort((a, b) => (a.sortKey === b.sortKey ? b.tieBreak - a.tieBreak : a.sortKey < b.sortKey ? 1 : -1));
}

/** 隨筆清單（「隨筆」篩選）：每篇一列，照寫下時間 */
export function essayItems(entries: BondEntry[]): BondEntry[] {
    return entries.filter(e => e.kind === 'essay').sort((a, b) => b.writtenAt - a.writtenAt);
}

export function filterTimeline(items: TimelineItem[], filter: TimelineFilter, showHidden: boolean): TimelineItem[] {
    return items.filter(it => {
        if (it.hidden && !showHidden) return false;
        if (filter === 'moment') return it.kind === 'moment';
        if (filter === 'milestone') return it.kind === 'milestone';
        if (filter === 'memory') return it.kind === 'memory';
        if (filter === 'favorite') return it.favorite;
        return true;
    });
}

/** 首頁「最近拾光」：收藏的優先，其次最新的；收起的不算 */
export function pickRecentItem(items: TimelineItem[]): TimelineItem | undefined {
    const visible = items.filter(i => !i.hidden);
    return visible.find(i => i.favorite) || visible[0];
}
