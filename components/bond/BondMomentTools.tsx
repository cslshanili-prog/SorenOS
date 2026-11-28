/**
 * 拾光工具（plans/bond-moments-v2.md）：拾光分頁右上「＋」開的全螢幕頁。
 * 一鍵補全、生成某一天、手動新增、從聊天挑願望／約定／禮物、多選刪除、清空 AI 寫的。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CalendarBlank, CheckSquare, PencilSimple, Sparkle, Stop, Trash, MagicWand } from '@phosphor-icons/react';
import type { APIConfig, BondEntry } from '../../types';
import { BondHeader } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import { useBackfill, itemHeadline } from './BondMomentsPage';
import { clearAiFragments, listFragmentDays, startBackfill, stopBackfill, writeFragmentDay, type FragmentDayUnit } from './fragmentRun';
import { clearableFragments, fragmentsOfDay, isFragment, tagTone } from '../../utils/bond/fragment';
import { bondOrBlank } from '../../utils/bond/store';
import { formatEventDate } from '../../utils/bond/eventDate';
import { deleteBondEntries, saveBondEntries } from '../../utils/bond/entries';
import { planRetract } from '../../utils/bond/derivation';
import { onBondRegistryChange } from '../../utils/bond/registry';
import { eventSortKey } from '../../utils/bond/eventDate';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;
type View = 'home' | 'days' | 'select';

const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
const dayText = (key: string) => {
    const [y, m, d] = key.split('-').map(Number);
    return `${formatEventDate({ precision: 'day', date: key })}${y ? `（${WEEK[new Date(y, m - 1, d).getDay()]}）` : ''}`;
};

/** 寫過哪幾天：跟著 bonds 登記表更新 */
function useFragmentDays(spaceId: string): Record<string, number> {
    const [days, setDays] = useState(() => bondOrBlank(spaceId).fragmentDays || {});
    useEffect(() => onBondRegistryChange(() => setDays(bondOrBlank(spaceId).fragmentDays || {})), [spaceId]);
    return days;
}

const Row: React.FC<{ icon: React.ReactNode; title: string; hint: string; onClick: () => void; tone?: 'mist' | 'blush' | 'panel'; disabled?: boolean }> = ({ icon, title, hint, onClick, tone = 'panel', disabled }) => (
    <button type="button" disabled={disabled} onClick={onClick}
        className={`w-full flex items-center gap-3.5 px-4 py-4 text-left disabled:opacity-50 ${tone === 'mist' ? 'bond-block bg-[var(--bond-block-mist)]' : tone === 'blush' ? 'bond-block bg-[var(--bond-block-blush)]' : 'bond-panel'}`}>
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--bond-card)] text-[var(--bond-accent)]">{icon}</span>
        <span className="min-w-0">
            <span className="bond-serif block text-[15px] font-semibold">{title}</span>
            <span className="block mt-0.5 text-[12px] leading-relaxed text-[var(--bond-muted)]">{hint}</span>
        </span>
    </button>
);

export const BondMomentToolsPage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    onBack: () => void;
    onNewMoment: () => void;
    /** 從聊天挑願望、約定、禮物（只有身份卡 × 角色） */
    onPick?: () => void;
    addToast: Toast;
}> = ({ space, apiConfig, onBack, onNewMoment, onPick, addToast }) => {
    const [view, setView] = useState<View>('home');
    const [days, setDays] = useState<FragmentDayUnit[] | null>(null);
    const done = useFragmentDays(space.id);
    const job = useBackfill(space.id);
    const entries = useBondEntries(space.id);
    const isPair = space.kind === 'pair';

    useEffect(() => {
        let alive = true;
        listFragmentDays(space).then(d => { if (alive) setDays(d); }).catch(() => { if (alive) setDays([]); });
        return () => { alive = false; };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [space.id]);

    const pending = useMemo(() => (days || []).filter(d => !done[d.dayKey]).length, [days, done]);
    const aiCount = clearableFragments(entries).length;
    const [confirmClear, setConfirmClear] = useState(false);

    if (view === 'days') return <DayPicker space={space} apiConfig={apiConfig} days={days} done={done} entries={entries} onBack={() => setView('home')} addToast={addToast} />;
    if (view === 'select') return <SelectDelete space={space} entries={entries} onBack={() => setView('home')} addToast={addToast} />;

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="拾光工具" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-4 pb-10 space-y-3">
                {/* 一鍵補全 */}
                <section className="bond-block bg-[var(--bond-block-sand)] px-5 py-5">
                    <div className="flex items-center gap-2 text-[13px] text-[var(--bond-ink-2)]"><Sparkle size={17} />一鍵補全</div>
                    <p className="mt-2 text-[13px] leading-relaxed text-[var(--bond-ink-2)]">
                        {days === null ? '正在看你們聊過哪些日子…'
                            : !days.length ? (isPair ? '他們還沒怎麼私下聊過。' : '你們還沒怎麼聊過。')
                                : pending ? `有 ${days.length} 天有對話，還有 ${pending} 天沒寫。從最早那天開始一天一天寫，寫過的不重寫。`
                                    : `${days.length} 天都寫好了。之後每天會自己寫。`}
                    </p>
                    {job?.running ? (
                        <>
                            <div className="mt-3 flex items-center justify-between text-[12.5px] text-[var(--bond-ink-2)]">
                                <span className="min-w-0 truncate">{job.total ? `正在寫 ${job.current ? formatEventDate({ precision: 'day', date: job.current }) : ''}（${job.done}/${job.total}）` : '準備中…'}</span>
                                <button type="button" className="shrink-0 inline-flex items-center gap-1 text-[var(--bond-accent)]" onClick={() => stopBackfill(space.id)}><Stop size={13} weight="fill" />停</button>
                            </div>
                            <div className="mt-2 h-[6px] rounded-full bg-[var(--bond-track)] overflow-hidden">
                                <div className="h-full rounded-full bg-[var(--bond-accent)] transition-all" style={{ width: `${job.total ? Math.round((job.done / job.total) * 100) : 4}%` }} />
                            </div>
                            <p className="mt-2 text-[11px] text-[var(--bond-muted)]">可以離開這頁，會在背景繼續寫。</p>
                        </>
                    ) : (
                        <>
                            {job?.finishedAt && (
                                <p className="mt-2 text-[12px] text-[var(--bond-muted)]">
                                    {job.error ? `上次停在一半：${job.error}` : job.stopped ? `上次停了，寫了 ${job.written} 則。` : `上次寫了 ${job.done} 天、${job.written} 則。`}
                                </p>
                            )}
                            <button type="button" className="mt-3 w-full bond-btn bond-btn-primary !py-2.5" disabled={!days?.length || !pending}
                                onClick={() => void startBackfill(space, apiConfig)}>
                                <Sparkle size={14} />{pending ? `補全 ${pending} 天` : '都寫好了'}
                            </button>
                        </>
                    )}
                </section>

                <Row icon={<CalendarBlank size={19} />} title="生成某一天" hint="選一天，私聊或見面都算；寫過的可以重寫。" onClick={() => setView('days')} tone="mist" />
                <Row icon={<PencilSimple size={19} />} title="手動新增" hint="自己寫一個想留著的片刻。" onClick={onNewMoment} />
                {onPick && <Row icon={<MagicWand size={19} />} title="從聊天挑願望、約定、禮物" hint="AI 先挑，你勾了才收存。" onClick={onPick} />}
                <Row icon={<CheckSquare size={19} />} title="多選刪除" hint="勾幾則一起刪。" onClick={() => setView('select')} />

                <section className="bond-panel px-4 py-4">
                    {!confirmClear ? (
                        <button type="button" className="w-full flex items-center gap-3.5 text-left disabled:opacity-50" disabled={!aiCount} onClick={() => setConfirmClear(true)}>
                            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-[var(--bond-block-blush)] text-[var(--bond-accent)]"><Trash size={19} /></span>
                            <span>
                                <span className="bond-serif block text-[15px] font-semibold">清空 AI 寫的</span>
                                <span className="block mt-0.5 text-[12px] text-[var(--bond-muted)]">{aiCount ? `${aiCount} 則；你寫的片刻、里程碑留著。` : '還沒有 AI 寫的。'}</span>
                            </span>
                        </button>
                    ) : (
                        <div>
                            <p className="text-[13px] leading-relaxed">清空 {aiCount} 則 AI 寫的片段？你寫的片刻、里程碑留著。清完可以再一鍵補全。</p>
                            <div className="mt-3 flex gap-2">
                                <button type="button" className="bond-btn flex-1" onClick={() => setConfirmClear(false)}>先不要</button>
                                <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={async () => {
                                    if (job?.running) stopBackfill(space.id);
                                    await clearAiFragments(space.id, clearableFragments(entries).map(e => e.id));
                                    setConfirmClear(false);
                                    addToast('清空了', 'success');
                                }}>清空</button>
                            </div>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
};

const DayPicker: React.FC<{
    space: ResolvedSpace; apiConfig: APIConfig; days: FragmentDayUnit[] | null; done: Record<string, number>; entries: BondEntry[];
    onBack: () => void; addToast: Toast;
}> = ({ space, apiConfig, days, done, entries, onBack, addToast }) => {
    const [busy, setBusy] = useState<string | null>(null);
    const list = useMemo(() => [...(days || [])].reverse(), [days]);
    const write = async (d: FragmentDayUnit) => {
        setBusy(d.dayKey);
        try {
            const cards = await writeFragmentDay({ ...space, bond: bondOrBlank(space.id) }, d, { apiConfig, replace: !!done[d.dayKey], how: '某一天' });
            addToast(cards.length ? `寫了 ${cards.length} 則` : '那天沒有挑出想記的', cards.length ? 'success' : 'info');
        } catch (e: any) {
            addToast(e?.message || '這次沒寫出來', 'error');
        } finally {
            setBusy(null);
        }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="生成某一天" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-3 pb-10">
                {days === null ? <p className="py-12 text-center text-[12.5px] text-[var(--bond-muted)]">正在看你們聊過哪些日子…</p>
                    : !list.length ? <p className="py-12 text-center text-[12.5px] text-[var(--bond-muted)]">還沒有可以寫的日子。</p> : (
                        <div className="bond-panel px-4 divide-y bond-hair">
                            {list.map(d => {
                                const n = fragmentsOfDay(entries, d.dayKey).length;
                                const kinds = [...new Set(d.parts.map(p => (p.from === 'date' ? '見面' : '聊天')))].join('、');
                                return (
                                    <div key={d.dayKey} className="py-3 flex items-center gap-3">
                                        <div className="min-w-0 flex-1">
                                            <div className="bond-serif text-[14.5px]">{dayText(d.dayKey)}</div>
                                            <div className="mt-0.5 text-[11.5px] text-[var(--bond-muted)]">{kinds} · {d.count} 則{done[d.dayKey] ? ` · 已寫 ${n} 則` : ' · 還沒寫'}</div>
                                        </div>
                                        <button type="button" className={`bond-btn !py-1.5 !text-[12px] ${done[d.dayKey] ? '' : 'bond-btn-primary'}`} disabled={!!busy} onClick={() => void write(d)}>
                                            {busy === d.dayKey ? '寫著…' : done[d.dayKey] ? '重寫' : '寫'}
                                        </button>
                                    </div>
                                );
                            })}
                        </div>
                    )}
            </div>
        </div>
    );
};

const SelectDelete: React.FC<{ space: ResolvedSpace; entries: BondEntry[]; onBack: () => void; addToast: Toast }> = ({ space, entries, onBack, addToast }) => {
    const [chosen, setChosen] = useState<Set<string>>(new Set());
    const [ask, setAsk] = useState(false);
    const list = useMemo(() => entries.filter(e => e.kind === 'moment')
        .sort((a, b) => { const ka = eventSortKey(a.eventDate); const kb = eventSortKey(b.eventDate); return ka === kb ? (b.fragment?.at ?? b.writtenAt) - (a.fragment?.at ?? a.writtenAt) : ka < kb ? 1 : -1; }), [entries]);
    const toggle = (id: string) => setChosen(prev => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
    const remove = async () => {
        let all = entries;
        const del: string[] = [];
        const updates: BondEntry[] = [];
        for (const id of chosen) {
            const plan = planRetract(all, { type: 'entry', id }, 'detach');
            del.push(...plan.deleteIds);
            updates.push(...plan.updates);
            all = all.map(e => plan.updates.find(u => u.id === e.id) || e);
        }
        if (updates.length) await saveBondEntries(updates.filter(u => !del.includes(u.id)));
        await deleteBondEntries(del);
        addToast(`刪了 ${del.length} 則`, 'success');
        setChosen(new Set());
        setAsk(false);
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="多選刪除" onBack={onBack}
                right={<button type="button" className="bond-note px-2 py-1" onClick={() => setChosen(chosen.size === list.length ? new Set() : new Set(list.map(e => e.id)))}>{chosen.size === list.length && list.length ? '全不選' : '全選'}</button>} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-4 pt-3 pb-4">
                {!list.length ? <p className="py-12 text-center text-[12.5px] text-[var(--bond-muted)]">還沒有東西。</p> : (
                    <div className="bond-panel px-4 divide-y bond-hair">
                        {list.map(e => {
                            const on = chosen.has(e.id);
                            return (
                                <button key={e.id} type="button" onClick={() => toggle(e.id)} className="w-full py-3 flex items-start gap-3 text-left">
                                    <span className={`mt-1 h-4 w-4 shrink-0 rounded-[4px] border grid place-items-center ${on ? 'bg-[var(--bond-accent)] border-[var(--bond-accent)] text-[var(--bond-on-accent)]' : 'border-[var(--bond-line)]'}`}>{on && <span className="text-[10px]">✓</span>}</span>
                                    <span className="min-w-0 flex-1">
                                        <span className="flex items-center gap-2 text-[11px] text-[var(--bond-muted)]">
                                            {formatEventDate(e.eventDate)}{e.fragment?.time ? ` ${e.fragment.time}` : ''}
                                            {isFragment(e) ? <span className="bond-tag !text-[10px]" data-tone={tagTone(e.fragment!.tag)}>{e.fragment!.tag}</span> : <span>你寫的</span>}
                                        </span>
                                        <span className="block mt-1 text-[13px] leading-relaxed line-clamp-2">{itemHeadline(e, 80)}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <div className="shrink-0 px-4 pt-3 border-t bond-hair" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                {!ask ? (
                    <button type="button" className="w-full bond-btn bond-btn-primary !py-2.5" disabled={!chosen.size} onClick={() => setAsk(true)}><Trash size={14} />刪掉 {chosen.size} 則</button>
                ) : (
                    <div>
                        <p className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">刪掉這 {chosen.size} 則？寫在它們上面的隨筆會留著，標「原本關聯的那件事已刪除」。{space.kind === 'persona' ? '' : ''}</p>
                        <div className="mt-2 flex gap-2">
                            <button type="button" className="bond-btn flex-1" onClick={() => setAsk(false)}>先不要</button>
                            <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={() => void remove()}>刪掉</button>
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
};
