/**
 * 「珍藏」分頁（plans/bond-batch5.md）：禮物、信件、留給以後。身份卡 × 角色的空間才有。
 * 禮物圖鑑照購物中心的送禮單＋卡片現排（utils/bond/gift.ts），不另存一份購物紀錄。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Gift, NotePencil } from '@phosphor-icons/react';
import type { BondEntry, MallOrder } from '../../types';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import { GiftBox } from './treasure/GiftBox';
import { BondPhotoStrip } from './BondPhotoPicker';
import { buildGiftViews, giftBucket, giftStats, giftWrapFor, type GiftBucket, type GiftView } from '../../utils/bond/gift';
import { onGiftOrderRegistryChange } from '../../utils/bond/giftOrderRegistry';
import { acceptGiftPending, attributeGiftOrders, dismissGiftPending, lineGiftOrders, syncGiftPlans } from './giftRun';
import { LetterTab } from './BondLetterPages';
import { CapsuleTab } from './BondCapsulePages';
import { unreadForUser } from '../../utils/bond/letter';
import { formatEventDate } from '../../utils/bond/eventDate';
import { getLocalDateKey } from '../../utils/localDate';

export type TreasureTab = 'gift' | 'letter' | 'capsule';

/** 這段關係的送禮單（跟著登記表變） */
export function useLineGiftOrders(space: ResolvedSpace): MallOrder[] {
    const [orders, setOrders] = useState<MallOrder[]>(() => lineGiftOrders(space.char, space.personaKey));
    useEffect(() => {
        const update = () => setOrders(lineGiftOrders(space.char, space.personaKey));
        update();
        return onGiftOrderRegistryChange(update);
    }, [space.char.id, space.personaKey]);
    return orders;
}

/** 圖鑑（你看到的那一份）：第一次打開時補舊訂單的線、連回打算送 */
export function useGiftViews(space: ResolvedSpace): { views: GiftView[]; entries: BondEntry[]; orders: MallOrder[] } {
    const entries = useBondEntries(space.id);
    const orders = useLineGiftOrders(space);
    useEffect(() => {
        let alive = true;
        (async () => {
            await attributeGiftOrders(space.char).catch(() => undefined);
            if (alive) await syncGiftPlans([{ bondId: space.id, char: space.char, personaKey: space.personaKey }]).catch(() => 0);
        })();
        return () => { alive = false; };
    }, [space.id]);
    const views = useMemo(() => buildGiftViews({ orders, entries, forViewer: 'user' }), [orders, entries]);
    return { views, entries, orders };
}

/** 分頁列上的小點：有 TA 送的、還沒拆的（不跑補線，便宜） */
export function useGiftFreshDot(space: ResolvedSpace): boolean {
    const entries = useBondEntries(space.id);
    const orders = useLineGiftOrders(space);
    const pending = (space.bond.giftFollowupPending || []).length;
    return useMemo(() => pending > 0 || buildGiftViews({ orders, entries, forViewer: 'user' }).some(v => giftIsFresh(v)) || unreadForUser(entries).length > 0
        || entries.some(e => e.kind === 'capsule' && !!e.capsule?.dueAt && !e.capsule.openedAt), [orders, entries, pending]);
}

/** TA 送的、送到了、你還沒拆的（一週以前的舊單當看過了，免得一打開滿滿都是小點；還在路上的等送到再拆） */
export const giftIsFresh = (v: GiftView, now = Date.now()): boolean =>
    v.dir === 'in' && v.state === 'given' && !v.secret && !v.entry?.seenAt && now - v.at < 7 * 86400_000;

const dayText = (ts: number) => formatEventDate({ precision: 'day', date: getLocalDateKey(new Date(ts)) });

export function giftSubline(v: GiftView, charName: string): string {
    if (v.state === 'planned') {
        const when = v.entry?.gift?.plannedFor ? `・打算 ${formatEventDate({ precision: 'day', date: v.entry.gift.plannedFor })}` : '';
        return `打算送${when}`;
    }
    const who = v.dir === 'out' ? '你送的' : `${charName}送的`;
    return `${who}・${dayText(v.at)}`;
}

export function giftTagline(v: GiftView): string {
    if (v.preparedDays) return `${v.dir === 'in' ? 'TA' : '你'}準備了 ${v.preparedDays} 天`;
    if (v.order && v.state === 'bought') return v.progress || '配送中';
    if (v.followups.length) return `後續 ${v.followups.length} 筆`;
    if (v.occasion) return v.occasion;
    if (v.state === 'planned') return '只有你看得到';
    return '';
}

/** 圖鑑上一格的圖：有照片放照片，沒有就畫一個盒子 */
export const GiftArt: React.FC<{ view: GiftView; size: number }> = ({ view, size }) => {
    const { wrap, ribbon } = giftWrapFor(view.key);
    if (view.photos.length) {
        return <div style={{ width: size, height: size }} className="overflow-hidden rounded-lg"><BondPhotoStrip galleryIds={view.photos.slice(0, 1)} size="lg" /></div>;
    }
    return <GiftBox wrap={wrap} ribbon={ribbon} size={size} faded={view.state === 'planned'} />;
};

/** 每日總結抓到的禮物後續：要記進去嗎（可以先改一下那句）；不自動寫 */
const GiftPendingCards: React.FC<{ space: ResolvedSpace; views: GiftView[]; onOpen: (key: string) => void }> = ({ space, views, onOpen }) => {
    const pending = space.bond.giftFollowupPending || [];
    const [edit, setEdit] = useState<Record<string, string>>({});
    const [busy, setBusy] = useState<string | null>(null);
    if (!pending.length) return null;
    return (
        <div className="mt-4 space-y-2.5">
            {pending.map(p => {
                const v = views.find(x => x.key === p.giftKey);
                const text = edit[p.id] ?? p.text;
                return (
                    <div key={p.id} className="rounded-xl border border-[var(--bond-rose)] bg-[var(--bond-card)] px-4 py-3">
                        <div className="text-[11px] tracking-[0.2em] text-[var(--bond-accent)]">要 記 進 後 續 嗎</div>
                        <div className="mt-1 text-[12px] text-[var(--bond-muted)]">
                            {p.date ? `${formatEventDate({ precision: 'day', date: p.date })}的總結提到` : '總結提到'}
                            {v ? <button type="button" className="mx-1 underline underline-offset-2 text-[var(--bond-ink-2)]" onClick={() => onOpen(v.key)}>{v.title}</button> : <span className="mx-1">{p.giftTitle}</span>}
                            {!v && '（這件已經不在圖鑑裡了）'}
                        </div>
                        <textarea className="bond-input bond-serif mt-2 min-h-[56px] text-[13.5px] leading-relaxed" value={text} maxLength={160}
                            onChange={e => setEdit(prev => ({ ...prev, [p.id]: e.target.value }))} />
                        <div className="mt-2 flex gap-2">
                            <button type="button" className="bond-btn flex-1" disabled={busy === p.id}
                                onClick={async () => { setBusy(p.id); await dismissGiftPending(space.id, p.id).catch(() => undefined); setBusy(null); }}>不用</button>
                            <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy === p.id || !v || !text.trim()}
                                onClick={async () => { setBusy(p.id); await acceptGiftPending(space, p, text).catch(() => undefined); setBusy(null); }}>記進去</button>
                        </div>
                    </div>
                );
            })}
        </div>
    );
};

export const BondTreasurePage: React.FC<{
    space: ResolvedSpace;
    tabBar: React.ReactNode;
    header: React.ReactNode;
    tab: TreasureTab;
    onTab: (t: TreasureTab) => void;
    onOpenGift: (key: string) => void;
    onNewGift: (mode: 'given' | 'planned') => void;
    onOpenLetter: (letterId: string) => void;
    onWriteLetter: () => void;
    onOpenSpecial: (key: string) => void;
    onOpenLetterSettings: () => void;
    onOpenCapsule: (id: string) => void;
    onSealCapsule: () => void;
}> = ({ space, tabBar, header, tab, onTab, onOpenGift, onNewGift, onOpenLetter, onWriteLetter, onOpenSpecial, onOpenLetterSettings, onOpenCapsule, onSealCapsule }) => {
    const { views } = useGiftViews(space);
    const [filter, setFilter] = useState<GiftBucket | 'all'>('all');
    const name = space.rightName;
    const stats = useMemo(() => giftStats(views), [views]);
    const list = views.filter(v => filter === 'all' || giftBucket(v) === filter);
    const newDot = views.some(v => giftIsFresh(v)) || (space.bond.giftFollowupPending || []).length > 0;
    const treasureEntries = useBondEntries(space.id);
    const letterDot = unreadForUser(treasureEntries).length > 0;
    const capsuleDot = treasureEntries.some(e => e.kind === 'capsule' && e.capsule?.dueAt && !e.capsule.openedAt);
    const SUBTABS: Array<{ id: TreasureTab; label: string }> = [{ id: 'gift', label: '禮物' }, { id: 'letter', label: '信件' }, { id: 'capsule', label: '留給以後' }];

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            {header}
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-5 pt-4 flex gap-2">
                    {SUBTABS.map(t => (
                        <button key={t.id} type="button" className="bond-chip relative" aria-pressed={tab === t.id} onClick={() => onTab(t.id)}>
                            {t.label}
                            {((t.id === 'gift' && newDot) || (t.id === 'letter' && letterDot) || (t.id === 'capsule' && capsuleDot)) && tab !== t.id && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--bond-accent)]" aria-label="有新的" />}
                        </button>
                    ))}
                </div>

                {tab === 'gift' && (
                    <div className="px-5 pt-4 pb-12">
                        <div className="grid grid-cols-2 gap-2">
                            <button type="button" onClick={() => onNewGift('given')} className="flex items-center gap-2 rounded-xl border bond-hair bg-[var(--bond-card)] px-3.5 py-3 text-left">
                                <Gift size={16} className="text-[var(--bond-accent)] shrink-0" />
                                <span className="min-w-0"><span className="bond-serif block text-[13.5px]">記一件禮物</span><span className="block text-[11px] text-[var(--bond-muted)] truncate">手作的、路上買的…</span></span>
                            </button>
                            <button type="button" onClick={() => onNewGift('planned')} className="flex items-center gap-2 rounded-xl border border-dashed border-[var(--bond-rose)] px-3.5 py-3 text-left">
                                <NotePencil size={16} className="text-[var(--bond-accent)] shrink-0" />
                                <span className="min-w-0"><span className="bond-serif block text-[13.5px]">打算送</span><span className="block text-[11px] text-[var(--bond-muted)] truncate">只有你看得到</span></span>
                            </button>
                        </div>
                        <GiftPendingCards space={space} views={views} onOpen={onOpenGift} />
                        {(stats.given > 0 || stats.received > 0) && (
                            <p className="mt-4 text-[12px] text-[var(--bond-ink-2)]">
                                你送了 {stats.given} 件、收到 {stats.received} 件
                                {stats.first && <>，第一件是<button type="button" className="mx-1 underline underline-offset-2" onClick={() => onOpenGift(stats.first!.key)}>{stats.first.title}</button></>}
                            </p>
                        )}
                        <div className="mt-4 flex gap-2">
                            {(['all', 'out', 'in', 'planned'] as const).map(f => (
                                <button key={f} type="button" className="bond-chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
                                    {f === 'all' ? '全部' : f === 'out' ? '我送的' : f === 'in' ? `${name}送的` : '打算送'}
                                </button>
                            ))}
                        </div>
                        {list.length === 0 ? (
                            <p className="py-12 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">
                                {filter === 'planned' ? '還沒有打算送的。想到了先記下，只有你看得到。' : '還沒有禮物。在購物中心送給 TA 的、TA 送你的，都會自己出現在這裡。'}
                            </p>
                        ) : (
                            <div className="mt-4 grid grid-cols-2 gap-2.5">
                                {list.map(v => {
                                    const fresh = giftIsFresh(v);
                                    const tag = giftTagline(v);
                                    return (
                                        <button key={v.key} type="button" onClick={() => onOpenGift(v.key)}
                                            className={`min-w-0 flex flex-col items-center gap-1 rounded-2xl px-3 pt-3 pb-2.5 text-left ${v.state === 'planned' ? 'border border-dashed border-[var(--bond-rose)]' : 'border bond-hair bg-[var(--bond-card)]'}`}>
                                            <div className="h-[86px] grid place-items-center"><GiftArt view={v} size={78} /></div>
                                            <div className="w-full bond-serif text-[13.5px] truncate">
                                                {v.title}{fresh && <span className="ml-1 inline-block h-1.5 w-1.5 rounded-full bg-[var(--bond-accent)] align-middle" aria-label="新的" />}
                                            </div>
                                            <div className="w-full text-[11px] text-[var(--bond-muted)] truncate">{giftSubline(v, name)}</div>
                                            {tag && <div className="w-full text-[10.5px] text-[var(--bond-accent)] truncate">{tag}</div>}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {tab === 'letter' && <LetterTab space={space} onOpen={onOpenLetter} onWrite={onWriteLetter} onOpenSpecial={onOpenSpecial} onOpenSettings={onOpenLetterSettings} />}
                {tab === 'capsule' && <CapsuleTab space={space} onOpen={onOpenCapsule} onSeal={onSealCapsule} />}
            </div>
        </div>
    );
};
