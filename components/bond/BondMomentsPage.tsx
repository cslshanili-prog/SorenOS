/**
 * 拾光分頁（plans/bond-moments-v2.md）：從你們的聊天、見面生成的時間線。
 * 左邊一條細線，每天一個節點（大號日期＋星期）；節點旁是那天的片段（時間、tag、TA 的心裡話、引的那句原話），
 * 你收存的片刻、里程碑用不同底色。你是讀者：片段每天自動寫，也能在「＋」的拾光工具一鍵補全、生成某一天。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Feather, Plus, Sparkle, Star, Stop } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CharacterProfile } from '../../types';
import { BondHeader } from './bondUi';
import type { ResolvedSpace } from './space';
import { useSpaceTimeline } from './useSpaceTimeline';
import { essayItems, type TimelineItem } from '../../utils/bond/timeline';
import { eventMonthKey, formatEventDate, formatMonthKey } from '../../utils/bond/eventDate';
import { fragmentTagsFor, tagTone } from '../../utils/bond/fragment';
import { backfillState, onBackfillChange, startBackfill, stopBackfill, type BackfillState } from './fragmentRun';

/** 日期那一欄的短寫法 */
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
    if (item.ref.type === 'entry' && item.ref.entry.fragment) return item.ref.entry.fragment.tag;
    if (item.kind === 'moment') return '片刻';
    if (item.kind === 'milestone') return '里程碑';
    if (item.ref.type === 'topic') {
        const owner = item.ref.ownerId === space.char.id ? space.char.name : space.other?.name;
        return `${owner || ''}的整理`;
    }
    return '記憶';
}

/** 片段引的那句話是誰說的 */
export function quoteSpeaker(space: ResolvedSpace, who: string | undefined): string {
    if (!who) return '';
    if (who === 'user') return space.leftName;
    if (who === space.char.id || who === 'char') return space.kind === 'pair' ? space.char.name : space.rightName;
    if (space.other && who === space.other.id) return space.other.name;
    return '';
}

const WEEK = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'];
const weekdayOf = (dayKey: string) => {
    const [y, m, d] = dayKey.split('-').map(Number);
    return y && m && d ? WEEK[new Date(y, m - 1, d).getDay()] : '';
};

export function useBackfill(spaceId: string): BackfillState | undefined {
    const [, force] = useState(0);
    useEffect(() => onBackfillChange(() => force(v => v + 1)), []);
    return backfillState(spaceId);
}

type Filter = { kind: 'all' } | { kind: 'tag'; tag: string } | { kind: 'mine' } | { kind: 'milestone' } | { kind: 'essay' } | { kind: 'favorite' };

const fragOf = (it: TimelineItem): BondEntry['fragment'] => (it.ref.type === 'entry' ? it.ref.entry.fragment : undefined);

export const BondMomentsPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    tabBar: React.ReactNode;
    onBack: () => void;
    onOpenItem: (key: string) => void;
    /** 拾光工具（一鍵補全、生成某一天、手動新增、多選刪除、清空） */
    onOpenTools: () => void;
    onOpenEssay?: (essayId: string) => void;
    /** 讓 TA 自己挑一件寫隨筆 */
    onChooseEssay?: () => void;
}> = ({ space, characters, apiConfig, tabBar, onBack, onOpenItem, onOpenTools, onOpenEssay, onChooseEssay }) => {
    const { items, entries } = useSpaceTimeline(space, characters);
    const [filter, setFilter] = useState<Filter>({ kind: 'all' });
    const [showHidden, setShowHidden] = useState(false);
    const job = useBackfill(space.id);
    const essays = useMemo(() => essayItems(entries), [entries]);
    const isPair = space.kind === 'pair';
    const hasFragments = items.some(it => !!fragOf(it));

    // tag 篩選：照路線的順序，只列有用到的；你改過的自訂 tag 排後面
    const tags = useMemo(() => {
        const used = new Set(items.map(it => fragOf(it)?.tag).filter((t): t is string => !!t));
        const order = fragmentTagsFor(space.bond.route);
        return [...order.filter(t => used.has(t)), ...[...used].filter(t => !order.includes(t))];
    }, [items, space.bond.route]);

    const shown = useMemo(() => items.filter(it => {
        if (it.hidden && !showHidden) return false;
        switch (filter.kind) {
            case 'tag': return fragOf(it)?.tag === filter.tag;
            case 'mine': return it.kind === 'moment' && !fragOf(it);
            case 'milestone': return it.kind === 'milestone';
            case 'favorite': return it.favorite;
            default: return true;
        }
    }), [items, filter, showHidden]);
    const hiddenCount = items.filter(i => i.hidden).length;

    // 月 → 天 → 那天的幾件
    const months = useMemo(() => {
        const out: Array<{ key: string; days: Array<{ key: string; label: string; items: TimelineItem[] }> }> = [];
        for (const it of shown) {
            const mk = eventMonthKey(it.eventDate);
            let month = out[out.length - 1];
            if (!month || month.key !== mk) { month = { key: mk, days: [] }; out.push(month); }
            const dk = it.eventDate.precision === 'day' ? it.eventDate.date : `~${shortEventDay(it)}`;
            let day = month.days[month.days.length - 1];
            if (!day || day.key !== dk) { day = { key: dk, label: shortEventDay(it), items: [] }; month.days.push(day); }
            day.items.push(it);
        }
        return out;
    }, [shown]);

    const chip = (active: boolean, label: string, onClick: () => void, tone?: string) => (
        <button key={label} type="button" className="bond-chip shrink-0" aria-pressed={active} onClick={onClick}>
            {tone && <span className="bond-dot mr-1.5 inline-block h-1.5 w-1.5 rounded-full" data-tone={tone} />}{label}
        </button>
    );

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={isPair ? `${space.leftName} & ${space.rightName}` : space.rightName} onBack={onBack}
                right={<button type="button" onClick={onOpenTools} aria-label="拾光工具" className="h-9 w-9 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]"><Plus size={19} /></button>} />
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-4 pt-1 pb-2 flex gap-2 overflow-x-auto no-scrollbar">
                    {chip(filter.kind === 'all', '全部', () => setFilter({ kind: 'all' }))}
                    {tags.map(t => chip(filter.kind === 'tag' && filter.tag === t, t, () => setFilter({ kind: 'tag', tag: t }), tagTone(t)))}
                    {chip(filter.kind === 'mine', '你寫的', () => setFilter({ kind: 'mine' }))}
                    {chip(filter.kind === 'milestone', '里程碑', () => setFilter({ kind: 'milestone' }))}
                    {chip(filter.kind === 'essay', '隨筆', () => setFilter({ kind: 'essay' }))}
                    {chip(filter.kind === 'favorite', '收藏', () => setFilter({ kind: 'favorite' }))}
                </div>
                {hiddenCount > 0 && filter.kind !== 'essay' && (
                    <div className="px-5 -mt-0.5 mb-1 text-right">
                        <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4 decoration-[var(--bond-line)]" onClick={() => setShowHidden(v => !v)}>
                            {showHidden ? '不顯示收起的' : `收起的 ${hiddenCount}`}
                        </button>
                    </div>
                )}

                {/* 一鍵補全正在跑：進度＋停 */}
                {job?.running && (
                    <div className="mx-4 mt-2 bond-block bg-[var(--bond-block-mist)] px-4 py-3">
                        <div className="flex items-center justify-between gap-3 text-[12.5px]">
                            <span className="min-w-0 truncate text-[var(--bond-ink-2)]">
                                {job.total ? `正在寫 ${job.current ? formatEventDate({ precision: 'day', date: job.current }) : ''}（${job.done}/${job.total}）` : '正在讀你們的聊天…'}
                            </span>
                            <button type="button" className="shrink-0 inline-flex items-center gap-1 text-[var(--bond-accent)]" onClick={() => stopBackfill(space.id)}><Stop size={13} weight="fill" />停</button>
                        </div>
                        <div className="mt-2 h-[5px] rounded-full bg-[var(--bond-track)] overflow-hidden">
                            <div className="h-full rounded-full bg-[var(--bond-accent)] transition-all" style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 4}%` }} />
                        </div>
                    </div>
                )}
                {!job?.running && job?.error && (
                    <div className="mx-4 mt-2 bond-block bg-[var(--bond-block-blush)] px-4 py-3 text-[12.5px] text-[var(--bond-ink-2)]">補到一半停了：{job.error}。寫好的都留著，可以到「＋」再接著補。</div>
                )}

                {filter.kind === 'essay' ? (
                    <div className="px-4 pt-2 pb-10">
                        {onChooseEssay && (
                            <button type="button" onClick={onChooseEssay}
                                className="mb-4 w-full flex items-center justify-between rounded-[18px] bg-[var(--bond-block-mist)] px-4 py-3.5 text-left">
                                <span>
                                    <span className="bond-serif block text-[14px]">{isPair ? '讓他們寫一篇' : `讓 ${space.rightName} 寫一篇`}</span>
                                    <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">從還沒寫過的事裡自己挑一件</span>
                                </span>
                                <Feather size={16} className="text-[var(--bond-accent)]" />
                            </button>
                        )}
                        {essays.length === 0 ? (
                            <div className="py-12 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">還沒有隨筆。點進時間線上的一件事，可以請{isPair ? '他們' : ` ${space.rightName} `}就那件事寫一篇。</div>
                        ) : (
                            <div className="bond-panel px-4 divide-y bond-hair">
                                {essays.map(e => (
                                    <button key={e.id} type="button" onClick={() => onOpenEssay?.(e.id)} className="w-full text-left py-3.5">
                                        <div className="text-[11px] text-[var(--bond-muted)]">
                                            {characters.find(c => c.id === e.author)?.name || ''} · 關於 {formatEventDate(e.eventDate)}{e.status === 'draft' ? ' · 草稿' : ''}{e.afterwordOf ? ' · 後記' : ''}
                                        </div>
                                        <div className="bond-serif mt-1 text-[14.5px] leading-relaxed line-clamp-2">{itemHeadline(e)}</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                ) : months.length === 0 ? (
                    <div className="px-6 py-14 text-center">
                        {filter.kind === 'all' && !hasFragments ? (
                            <>
                                <div className="bond-serif text-[16px]">{isPair ? '他們的時間線還是空的' : '你們的時間線還是空的'}</div>
                                <p className="mt-2 text-[12.5px] leading-relaxed text-[var(--bond-muted)]">
                                    {isPair ? `從${space.char.name}和${space.other?.name}的私聊，` : `從你和${space.rightName}的聊天、見面，`}一天一天寫成幾個時刻。之後每天會自己寫。
                                </p>
                                <button type="button" className="mt-5 bond-btn bond-btn-primary" disabled={!!job?.running} onClick={() => void startBackfill(space, apiConfig)}>
                                    <Sparkle size={14} />一鍵補全
                                </button>
                            </>
                        ) : (
                            <div className="text-[12.5px] text-[var(--bond-muted)]">這一類還沒有東西。</div>
                        )}
                    </div>
                ) : (
                    <div className="pb-12">
                        {months.map(m => (
                            <section key={m.key || 'unknown'} className="mt-3">
                                <div className="px-5 pb-1 bond-serif text-[15px] tracking-[0.12em] text-[var(--bond-rose)]">{m.key ? formatMonthKey(m.key) : '不知道是什麼時候'}</div>
                                {m.days.map(d => (
                                    <div key={d.key} className="relative flex gap-3 pl-4 pr-4">
                                        {/* 左欄：日期與節點，細線貫穿整天 */}
                                        <div className="relative w-12 shrink-0">
                                            <div className="absolute left-[23px] top-0 bottom-0 w-px bg-[var(--bond-line)]" aria-hidden />
                                            <div className="relative z-[1] mt-3 flex flex-col items-center bg-[var(--bond-paper)] py-1">
                                                <span className="bond-serif text-[20px] leading-none tabular-nums text-[var(--bond-ink)]">{d.key.startsWith('~') ? '·' : Number(d.key.slice(8, 10))}</span>
                                                <span className="mt-1 text-[10px] tracking-wider text-[var(--bond-muted)]">{d.key.startsWith('~') ? d.label : weekdayOf(d.key)}</span>
                                            </div>
                                        </div>
                                        <div className="min-w-0 flex-1 space-y-2.5 py-2.5">
                                            {d.items.map(it => <TimelineCard key={it.key} item={it} space={space} onOpen={() => onOpenItem(it.key)} />)}
                                        </div>
                                    </div>
                                ))}
                            </section>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

const TimelineCard: React.FC<{ item: TimelineItem; space: ResolvedSpace; onOpen: () => void }> = ({ item, space, onOpen }) => {
    const f = fragOf(item);
    const fav = item.favorite ? <Star size={11} weight="fill" className="text-[var(--bond-accent)]" /> : null;
    const extra = item.essays.length > 0 ? <span className="text-[10.5px] text-[var(--bond-muted)]">隨筆 {item.essays.length}</span> : null;
    if (f) {
        const speaker = quoteSpeaker(space, f.quote?.who);
        return (
            <button type="button" onClick={onOpen} className={`block w-full text-left bond-panel px-4 py-3.5 ${item.hidden ? 'opacity-50' : ''}`}>
                <div className="flex items-center gap-2">
                    <span className="text-[11.5px] tabular-nums text-[var(--bond-muted)]">{f.time || ''}{f.from === 'date' ? ' · 見面' : ''}</span>
                    <span className="ml-auto inline-flex items-center gap-1.5">{fav}{extra}<span className="bond-tag" data-tone={tagTone(f.tag)}>{f.tag}</span></span>
                </div>
                <p className="bond-serif mt-2 text-[14.5px] leading-[1.75] text-[var(--bond-ink)] line-clamp-4">{item.text}</p>
                {f.quote?.text && (
                    <div className="mt-2.5 rounded-r-lg border-l-2 border-[var(--bond-accent)] bg-[var(--bond-paper-2)] px-3 py-2">
                        {speaker && <div className="text-[10.5px] tracking-wider text-[var(--bond-accent)]">{speaker}</div>}
                        <div className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)] line-clamp-2">{f.quote.text}</div>
                    </div>
                )}
            </button>
        );
    }
    if (item.kind === 'milestone') {
        return (
            <button type="button" onClick={onOpen} className={`block w-full text-left bond-block bg-[var(--bond-accent)] px-4 py-3.5 text-[var(--bond-on-accent)] ${item.hidden ? 'opacity-50' : ''}`}>
                <div className="flex items-center justify-between text-[10.5px] tracking-[0.2em] opacity-80"><span>里程碑</span>{fav}</div>
                <div className="bond-serif mt-1 text-[16px] font-semibold leading-snug">{itemHeadline(item, 60)}</div>
            </button>
        );
    }
    return (
        <button type="button" onClick={onOpen} className={`block w-full text-left bond-block bg-[var(--bond-block-blush)] px-4 py-3.5 ${item.hidden ? 'opacity-50' : ''}`}>
            <div className="flex items-center justify-between text-[10.5px] tracking-[0.2em] text-[var(--bond-accent)]"><span>{item.ref.type === 'entry' && item.ref.entry.author !== 'user' ? '片刻' : '你收存的'}</span><span className="inline-flex items-center gap-1.5">{fav}{extra}</span></div>
            {item.title?.trim() && <div className="bond-serif mt-1 text-[15px] font-semibold leading-snug">{item.title}</div>}
            <p className={`mt-1 text-[13px] leading-relaxed ${item.title?.trim() ? 'text-[var(--bond-ink-2)]' : 'bond-serif text-[14.5px] text-[var(--bond-ink)]'} line-clamp-3`}>{item.text}</p>
        </button>
    );
};
