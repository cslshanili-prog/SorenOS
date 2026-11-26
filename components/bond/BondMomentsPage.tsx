/**
 * 拾光分頁（plans/bond-batch2.md 第 4 節）：時間線＝記憶骨幹＋收存的片刻，照事件日期新到舊、按月分段。
 * 書頁的排法：月份是頁邊小字，每件事左邊一行日期註記，右邊是標題或首句。
 */
import React, { useMemo, useState } from 'react';
import { Plus, Sparkle, Star } from '@phosphor-icons/react';
import type { CharacterProfile } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useSpaceTimeline } from './useSpaceTimeline';
import { essayItems, filterTimeline, type TimelineFilter, type TimelineItem } from '../../utils/bond/timeline';
import { eventMonthKey, formatEventDate, formatMonthKey } from '../../utils/bond/eventDate';

const FILTERS: Array<{ id: TimelineFilter; label: string }> = [
    { id: 'all', label: '全部' },
    { id: 'moment', label: '片刻' },
    { id: 'memory', label: '記憶' },
    { id: 'essay', label: '隨筆' },
    { id: 'favorite', label: '收藏' },
];

/** 日期那一欄的短寫法：同一個月裡只寫日 */
export function shortEventDay(item: Pick<TimelineItem, 'eventDate'>): string {
    const d = item.eventDate;
    if (d.precision === 'day') return `${Number(d.date.slice(5, 7))}.${Number(d.date.slice(8, 10))}`;
    if (d.precision === 'month') return '某天';
    if (d.precision === 'period') return d.label.trim() || '某段時間';
    return '—';
}

export function itemHeadline(item: Pick<TimelineItem, 'title' | 'text'>, max = 70): string {
    const t = (item.title || '').trim();
    if (t) return t;
    const s = (item.text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? `${s.slice(0, max)}…` : s;
}

export function itemKindLabel(item: TimelineItem, space: ResolvedSpace): string {
    if (item.kind === 'moment') return '片刻';
    if (item.ref.type === 'topic') {
        const owner = item.ref.ownerId === space.char.id ? space.char.name : space.other?.name;
        return `${owner || ''}的整理`;
    }
    return '記憶';
}

export const BondMomentsPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    tabBar: React.ReactNode;
    onBack: () => void;
    onOpenItem: (key: string) => void;
    onNewMoment: () => void;
    /** 從最近的聊天挑幾件 */
    onPick?: () => void;
}> = ({ space, characters, tabBar, onBack, onOpenItem, onNewMoment, onPick }) => {
    const { items, entries } = useSpaceTimeline(space, characters);
    const [filter, setFilter] = useState<TimelineFilter>('all');
    const [showHidden, setShowHidden] = useState(false);
    const essays = useMemo(() => essayItems(entries), [entries]);
    const shown = useMemo(() => filterTimeline(items, filter, showHidden), [items, filter, showHidden]);
    const hiddenCount = items.filter(i => i.hidden).length;
    const isPair = space.kind === 'pair';

    const groups = useMemo(() => {
        const out: Array<{ key: string; items: TimelineItem[] }> = [];
        for (const it of shown) {
            const key = eventMonthKey(it.eventDate);
            const last = out[out.length - 1];
            if (last && last.key === key) last.items.push(it);
            else out.push({ key, items: [it] });
        }
        // 日期不明的放最後一段（排序鍵是空字串，本來就在最後；這裡把散落的併成一段）
        const unknown = out.filter(g => !g.key).flatMap(g => g.items);
        const known = out.filter(g => g.key);
        return unknown.length ? [...known, { key: '', items: unknown }] : known;
    }, [shown]);

    const filters = FILTERS.filter(f => f.id !== 'essay' || essays.length > 0);

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={isPair ? `${space.leftName} & ${space.rightName}` : space.rightName} onBack={onBack}
                right={<button type="button" onClick={onNewMoment} aria-label="收存一個片刻" className="h-9 w-9 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]"><Plus size={18} /></button>} />
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                {onPick && (
                    <button type="button" onClick={onPick}
                        className="mx-5 mt-4 w-[calc(100%-2.5rem)] flex items-center justify-between rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3 text-left">
                        <span>
                            <span className="bond-serif block text-[14px]">從最近的聊天挑幾件</span>
                            <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">AI 先挑，你勾了才收存</span>
                        </span>
                        <Sparkle size={16} className="text-[var(--bond-accent)]" />
                    </button>
                )}
                <div className="px-5 pt-4 pb-2 flex flex-wrap items-center gap-2">
                    {filters.map(f => (
                        <button key={f.id} type="button" className="bond-chip" aria-pressed={filter === f.id} onClick={() => setFilter(f.id)}>{f.label}</button>
                    ))}
                    {hiddenCount > 0 && filter !== 'essay' && (
                        <button type="button" className="ml-auto text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4 decoration-[var(--bond-line)]"
                            onClick={() => setShowHidden(v => !v)}>
                            {showHidden ? '不顯示收起的' : `收起的 ${hiddenCount}`}
                        </button>
                    )}
                </div>

                {filter === 'essay' ? (
                    <div className="px-5 pb-10">
                        <div className="divide-y bond-hair border-y">
                            {essays.map(e => (
                                <div key={e.id} className="py-3.5">
                                    <div className="text-[11px] text-[var(--bond-muted)]">
                                        關於 {formatEventDate(e.eventDate)}{e.status === 'draft' ? ' · 草稿' : ''}{e.afterwordOf ? ' · 後記' : ''}
                                    </div>
                                    <div className="bond-serif mt-1 text-[14.5px] leading-relaxed">{itemHeadline(e)}</div>
                                </div>
                            ))}
                        </div>
                    </div>
                ) : groups.length === 0 ? (
                    <div className="px-8 py-16 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">
                        {filter === 'all'
                            ? (isPair
                                ? '他們私下聊滿一段之後，整理出來的事會出現在這裡；也可以按右上角＋收存一個片刻。'
                                : '還沒有記下的事。聊天每天的總結會自動出現在這裡，也可以按右上角＋收存一個片刻。')
                            : '這一類還沒有東西。'}
                    </div>
                ) : (
                    <div className="pb-12">
                        {groups.map(g => (
                            <section key={g.key || 'unknown'} className="mt-4">
                                <div className="px-5"><SectionLabel>{formatMonthKey(g.key)}</SectionLabel></div>
                                <div className="mx-5 divide-y bond-hair border-y">
                                    {g.items.map(it => (
                                        <button key={it.key} type="button" onClick={() => onOpenItem(it.key)}
                                            className={`w-full text-left py-3.5 flex gap-4 ${it.hidden ? 'opacity-50' : ''}`}>
                                            <div className="w-12 shrink-0 pt-0.5 text-[11.5px] text-[var(--bond-muted)] tabular-nums leading-snug">{shortEventDay(it)}</div>
                                            <div className="min-w-0 flex-1">
                                                <div className={`text-[14.5px] leading-relaxed ${it.kind === 'moment' ? 'bond-serif' : 'text-[var(--bond-ink-2)] text-[13.5px]'}`}>
                                                    {itemHeadline(it)}
                                                </div>
                                                <div className="mt-1 flex items-center gap-2 text-[10.5px] tracking-wider text-[var(--bond-muted)]">
                                                    <span>{itemKindLabel(it, space)}</span>
                                                    {it.essays.length > 0 && <span>· 隨筆 {it.essays.length}</span>}
                                                    {it.hidden && <span>· 收起了</span>}
                                                    {it.favorite && <Star size={11} weight="fill" className="text-[var(--bond-rose)]" />}
                                                </div>
                                            </div>
                                        </button>
                                    ))}
                                </div>
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};
