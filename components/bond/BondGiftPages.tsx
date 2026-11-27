/**
 * 珍藏 · 禮物（plans/bond-batch5.md 第 2 節）：一件禮物（全螢幕）、記一件／打算送（全螢幕書寫頁）。
 * 購物中心的單沒有卡時，第一次補東西才寫一張疊上去的卡（overlayForOrder）。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowUUpLeft, ChatCircleText, Images, ShoppingBag, Sparkle, Trash } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, BondSource, CalendarEvent, GalleryImage } from '../../types';
import { upcomingAnniversaries } from '../../utils/bond/spaces';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { GiftBox } from './treasure/GiftBox';
import { BondPhotoPicker, BondPhotoStrip, BOND_PHOTO_LIMIT } from './BondPhotoPicker';
import { giftIsFresh, giftSubline, useGiftViews } from './BondTreasurePage';
import { giftCardContext } from './giftRun';
import { refreshAchievements } from './pactRun';
import {
    addFollowup, giftWrapFor, markGiven, newGift, overlayForOrder, patchGift, removeFollowup, type GiftView,
} from '../../utils/bond/gift';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { formatEventDate } from '../../utils/bond/eventDate';
import { getLocalDateKey } from '../../utils/localDate';
import { DB } from '../../utils/db';
import { canGenerateFor } from '../../utils/imageStyle';
import { generateImage } from '../../utils/imageGeneration';
import { migrateDataUrlToRef } from '../../utils/blobRef';
import { lineFor } from '../../utils/chatLine';
import { trackEvent } from '../../utils/analytics';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

export const GIFT_OCCASIONS = ['生日', '紀念日', '節日', '道歉', '辛苦了', '想到你', '沒有理由'];

const Footer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>{children}</div>
);

/** 這件禮物的卡：有就回，沒有（只有訂單）就寫一張疊上去 */
async function ensureEntry(space: ResolvedSpace, view: GiftView): Promise<BondEntry> {
    if (view.entry) return bondEntryById(view.entry.id) || view.entry;
    if (!view.order) throw new Error('找不到這件禮物');
    return saveBondEntry(overlayForOrder(space.id, view.order));
}

const dayText = (ts: number) => formatEventDate({ precision: 'day', date: getLocalDateKey(new Date(ts)) });

// ─── 一件禮物 ───────────────────────────────────────

export const BondGiftPage: React.FC<{
    space: ResolvedSpace;
    giftKey: string;
    apiConfig: APIConfig;
    onBack: () => void;
    onEdit: (entryId: string) => void;
    onOpenSource: (src: BondSource) => void;
    onBringToChat?: (view: GiftView) => void;
    /** 打算送的「去買」：開購物中心、那件放進購物車 */
    onGoBuy?: (view: GiftView) => void;
    addToast: Toast;
}> = ({ space, giftKey, apiConfig, onBack, onEdit, onOpenSource, onBringToChat, onGoBuy, addToast }) => {
    const { views } = useGiftViews(space);
    // 打算送的買了之後，那張卡疊到訂單上（key 從 e: 變 o:）：照卡 id 也認得出來
    const view = views.find(v => v.key === giftKey) || (giftKey.startsWith('e:') ? views.find(v => v.entry?.id === giftKey.slice(2)) : undefined);
    const name = space.rightName;
    const [opened, setOpened] = useState<boolean>(() => !(view && giftIsFresh(view)));
    const [card, setCard] = useState<{ source: BondSource; reply?: string } | null>(null);
    const [follow, setFollow] = useState('');
    const [picking, setPicking] = useState(false);
    const [genOpen, setGenOpen] = useState(false);
    const [genPrompt, setGenPrompt] = useState('');
    const [busy, setBusy] = useState<string | null>(null);
    const [editingReaction, setEditingReaction] = useState(false);
    const [confirmUncount, setConfirmUncount] = useState(false);
    const [reaction, setReaction] = useState('');

    useEffect(() => {
        let alive = true;
        if (view?.order) giftCardContext(space.char, view.order.id).then(c => { if (alive) setCard(c); }).catch(() => undefined);
        return () => { alive = false; };
    }, [view?.order?.id]);

    if (!view) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="禮物" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這件禮物已經不在了。</div>
            </div>
        );
    }
    const g = view.entry?.gift;
    const { wrap, ribbon } = giftWrapFor(view.key);
    const firstEmoji = view.items.find(i => i.emoji)?.emoji;
    const shownReaction = g?.reaction || (view.dir === 'out' ? card?.reply : undefined);
    const manual = !view.order;

    const unwrap = async () => {
        setOpened(true);
        try {
            const e = await ensureEntry(space, view);
            await saveBondEntry({ ...e, seenAt: Date.now() });
        } catch { /* 標不了已讀不影響拆 */ }
    };

    const save = async (fn: (e: BondEntry) => BondEntry, okText?: string) => {
        setBusy('save');
        try {
            const e = await ensureEntry(space, view);
            await saveBondEntry(fn(e));
            void refreshAchievements(space).catch(() => undefined);
            if (okText) addToast(okText, 'success');
        } catch (err: any) {
            addToast(`沒存成功：${err?.message || err}`, 'error');
        } finally {
            setBusy(null);
        }
    };

    const addFollow = async () => {
        const text = follow.trim();
        if (!text) return;
        await save(e => addFollowup(e, { by: 'user', text }));
        setFollow('');
        trackEvent('羁绊礼物', { 动作: '后续', 方向: view.dir === 'out' ? '我送' : 'TA送', 来源: view.order ? '购物' : '手记' });
    };

    const imageCfg = apiConfig.imageGenConfig;
    const canGen = canGenerateFor(imageCfg, 'bondGift');
    const openGen = () => {
        const items = view.items.map(i => i.name).filter(Boolean).join('、');
        setGenPrompt(`一張照片：${view.title}${items && items !== view.title ? `（${items}）` : ''}${view.occasion ? `，${view.occasion}的禮物` : ''}。安靜的靜物特寫，自然光，溫暖，沒有文字。`);
        setGenOpen(true);
    };
    const generate = async () => {
        if (!canGen || !genPrompt.trim()) return;
        setBusy('gen');
        try {
            const r = await generateImage(imageCfg!, genPrompt.trim(), undefined, { feature: 'bondGift', char: space.char, hasPerson: false });
            const url = await migrateDataUrlToRef(r.dataUrl);
            const line = lineFor(space.char, space.personaKey);
            const img: GalleryImage = {
                id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, charId: space.char.id, url, timestamp: Date.now(),
                origin: 'generated', description: `禮物：${view.title}`, ...(line.personaKey ? { personaKey: line.personaKey } : {}),
            };
            await DB.saveGalleryImage(img);
            await save(e => patchGift(e, { photos: [...(e.gift?.photos || []), img.id].slice(-BOND_PHOTO_LIMIT) }), '生好了，也存進資料庫了');
            setGenOpen(false);
            trackEvent('羁绊礼物', { 动作: '照片', 方向: view.dir === 'out' ? '我送' : 'TA送', 来源: '生成' });
        } catch (err: any) {
            addToast(err?.message || '沒生成功', 'error');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={view.state === 'planned' ? '打算送' : view.dir === 'out' ? `送給${name}的` : `${name}送的`} onBack={onBack}
                right={manual ? <button type="button" className="text-[12.5px] text-[var(--bond-accent)] px-2" onClick={() => onEdit(view.entry!.id)}>改</button> : undefined} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6 space-y-7">
                <div className="flex flex-col items-center pt-24">
                    {view.photos.length && opened && view.state !== 'bought' ? (
                        <div className="w-full -mt-20"><BondPhotoStrip galleryIds={view.photos} size="lg" /></div>
                    ) : (
                        <GiftBox wrap={wrap} ribbon={ribbon} size={200} open={opened && view.state === 'given'} faded={view.state === 'planned'}>
                            <div className="text-[52px] leading-none">{firstEmoji || '🎁'}</div>
                        </GiftBox>
                    )}
                    {!opened && view.state === 'given' && (
                        <button type="button" className="bond-btn bond-btn-primary mt-4" onClick={unwrap}>拆開</button>
                    )}
                    {view.state === 'bought' && view.dir === 'in' && <p className="mt-3 text-[12px] text-[var(--bond-muted)]">還在路上，送到了再拆。</p>}
                    <h2 className="bond-serif mt-4 text-[20px] text-center">{view.title}</h2>
                    <p className="mt-1 text-[12px] text-[var(--bond-muted)]">{giftSubline(view, name)}{view.order && view.state === 'bought' ? `・${view.progress}` : ''}</p>
                    {view.preparedDays && <p className="mt-1 text-[12px] text-[var(--bond-accent)]">{view.dir === 'in' ? `${name}偷偷準備了 ${view.preparedDays} 天` : `你準備了 ${view.preparedDays} 天`}</p>}
                </div>

                {view.items.length > 0 && (view.items.length > 1 || view.items[0].name !== view.title) && (
                    <section>
                        <SectionLabel>裡 面 有</SectionLabel>
                        <ul className="space-y-1 text-[13.5px]">
                            {view.items.map((i, n) => <li key={n}>{i.emoji ? `${i.emoji} ` : ''}{i.name}{i.qty && i.qty > 1 ? ` ×${i.qty}` : ''}{i.shop ? <span className="text-[11px] text-[var(--bond-muted)]">・{i.shop}</span> : null}</li>)}
                        </ul>
                    </section>
                )}

                {view.order?.note && (
                    <section>
                        <SectionLabel>附 的 話</SectionLabel>
                        <p className="bond-serif text-[14px] leading-relaxed border-l-2 border-[var(--bond-rose)] pl-3">{view.order.note}</p>
                    </section>
                )}

                <section>
                    <SectionLabel>場 合</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {GIFT_OCCASIONS.map(o => (
                            <button key={o} type="button" className="bond-chip" aria-pressed={view.occasion === o}
                                onClick={() => void save(e => patchGift(e, { occasion: view.occasion === o ? undefined : o }))}>{o}</button>
                        ))}
                    </div>
                </section>

                {view.state !== 'planned' && (
                    <section>
                        <SectionLabel right={!editingReaction ? <button type="button" className="text-[11.5px] text-[var(--bond-accent)]" onClick={() => { setReaction(shownReaction || ''); setEditingReaction(true); }}>{shownReaction ? '改' : '寫一句'}</button> : undefined}>
                            {view.dir === 'out' ? `${name} 收 到 時` : '你 收 到 時'}
                        </SectionLabel>
                        {editingReaction ? (
                            <div className="space-y-2">
                                <textarea className="bond-input bond-serif min-h-[70px]" value={reaction} onChange={e => setReaction(e.target.value)} maxLength={200} />
                                <div className="flex gap-2 justify-end">
                                    <button type="button" className="bond-btn" onClick={() => setEditingReaction(false)}>取消</button>
                                    <button type="button" className="bond-btn bond-btn-primary" onClick={() => { void save(e => patchGift(e, { reaction: reaction.trim() || undefined })); setEditingReaction(false); }}>存</button>
                                </div>
                            </div>
                        ) : shownReaction ? (
                            <p className="bond-serif text-[14px] leading-relaxed">「{shownReaction}」</p>
                        ) : (
                            <p className="text-[12px] text-[var(--bond-muted)]">{view.dir === 'out' ? '還沒抓到 TA 的反應，可以自己寫一句。' : '當時的心情，寫一句留著。'}</p>
                        )}
                    </section>
                )}

                <section>
                    <SectionLabel right={
                        <span className="flex gap-3">
                            <button type="button" className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1" onClick={() => setPicking(true)}><Images size={12} />資料庫</button>
                            {canGen && <button type="button" className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1" onClick={openGen}><Sparkle size={12} />生一張</button>}
                        </span>
                    }>照 片</SectionLabel>
                    {view.photos.length ? <BondPhotoStrip galleryIds={view.photos} size="sm" /> : <p className="text-[12px] text-[var(--bond-muted)]">還沒有照片。</p>}
                    {genOpen && (
                        <div className="mt-3 space-y-2 rounded-xl border bond-hair bg-[var(--bond-card)] p-3">
                            <textarea className="bond-input min-h-[80px] text-[13px]" value={genPrompt} onChange={e => setGenPrompt(e.target.value)} />
                            <div className="flex gap-2 justify-end">
                                <button type="button" className="bond-btn" onClick={() => setGenOpen(false)}>先不要</button>
                                <button type="button" className="bond-btn bond-btn-primary" disabled={busy === 'gen'} onClick={generate}>{busy === 'gen' ? '生成中…' : '生成'}</button>
                            </div>
                        </div>
                    )}
                </section>

                {view.state !== 'planned' && (
                    <section>
                        <SectionLabel>後 續</SectionLabel>
                        {view.followups.length > 0 && (
                            <ol className="mb-3 space-y-2 border-l border-[var(--bond-line)] pl-3">
                                {view.followups.map(f => (
                                    <li key={f.id} className="flex items-start gap-2">
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-[10.5px] text-[var(--bond-muted)]">{dayText(f.at)}{f.by !== 'user' ? `・${name}` : ''}</span>
                                            <span className="bond-serif block text-[13.5px] leading-relaxed">{f.text}</span>
                                        </span>
                                        <button type="button" aria-label="刪掉這筆" className="text-[var(--bond-muted)] p-1" onClick={() => void save(e => removeFollowup(e, f.id))}><Trash size={13} /></button>
                                    </li>
                                ))}
                            </ol>
                        )}
                        <div className="flex gap-2">
                            <input className="bond-input" value={follow} maxLength={120} placeholder={view.dir === 'out' ? '他戴去見面了、壞了、收進抽屜……' : '你用了、帶出門了、擺在桌上……'}
                                onChange={e => setFollow(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addFollow(); }} />
                            <button type="button" className="bond-btn shrink-0" disabled={!follow.trim() || !!busy} onClick={addFollow}>記一筆</button>
                        </div>
                    </section>
                )}

                {view.order && (
                    <section className="pt-2">
                        {!confirmUncount ? (
                            <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-2" onClick={e => {
                                const sec = e.currentTarget.closest('section');
                                setConfirmUncount(true);
                                window.setTimeout(() => sec?.scrollIntoView({ block: 'end', behavior: 'smooth' }), 30);
                            }}>這件不算禮物</button>
                        ) : (
                            <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
                                <p className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">移出圖鑑？{name}也不會再把它當成你們互送的禮物。聊天裡那張購物卡上可以再「算禮物」收回來。</p>
                                <div className="mt-2.5 flex gap-2">
                                    <button type="button" className="bond-btn flex-1" onClick={() => setConfirmUncount(false)}>先不要</button>
                                    <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!!busy} onClick={async () => {
                                        await save(e => patchGift(e, { counts: false }), '移出圖鑑了');
                                        trackEvent('羁绊礼物', { 动作: '移出', 方向: view.dir === 'out' ? '我送' : 'TA送', 来源: view.order?.kind === 'food' ? '外卖' : '购物' });
                                        onBack();
                                    }}>移出</button>
                                </div>
                            </div>
                        )}
                    </section>
                )}
            </div>
            <Footer>
                {card?.source && <button type="button" className="bond-btn flex-1" onClick={() => onOpenSource(card.source)}><ArrowUUpLeft size={14} />回到那時</button>}
                {onBringToChat && view.state !== 'planned' && <button type="button" className="bond-btn flex-1" onClick={() => onBringToChat(view)}><ChatCircleText size={14} />帶去聊聊</button>}
                {manual && view.state === 'planned' && view.dir === 'out' && onGoBuy && (
                    <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={() => onGoBuy(view)}><ShoppingBag size={14} />去買</button>
                )}
                {manual && view.state !== 'given' && view.dir === 'out' && (
                    <button type="button" className={`bond-btn flex-1 ${onGoBuy && view.state === 'planned' ? '' : 'bond-btn-primary'}`} onClick={() => void save(e => markGiven(e), '記成送出了')}>{view.state === 'planned' ? '送出了（沒走購物中心）' : '送出了'}</button>
                )}
            </Footer>
            {picking && <BondPhotoPicker initial={view.photos} onBack={() => setPicking(false)} onDone={ids => {
                setPicking(false);
                void save(e => patchGift(e, { photos: ids.length ? ids : undefined }));
                if (ids.length) trackEvent('羁绊礼物', { 动作: '照片', 方向: view.dir === 'out' ? '我送' : 'TA送', 来源: '资料库' });
            }} />}
        </div>
    );
};

// ─── 記一件／打算送／改 ──────────────────────────────

export const BondGiftEditPage: React.FC<{
    space: ResolvedSpace;
    entryId?: string;
    mode: 'given' | 'planned';
    /** 從願望來的（願望頁「我想送這個」） */
    fromWish?: BondEntry;
    /** 行事曆的事件（打算哪天送可以直接選一個紀念日） */
    events?: CalendarEvent[];
    onBack: () => void;
    onDone: (giftKey: string) => void;
    addToast: Toast;
}> = ({ space, entryId, mode, fromWish, events, onBack, onDone, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const g = existing?.gift;
    const planned = existing ? g?.state === 'planned' : mode === 'planned';
    const name = space.rightName;
    const [dir, setDir] = useState<'out' | 'in'>(g?.dir || 'out');
    const [title, setTitle] = useState(existing?.title || fromWish?.text.slice(0, 40) || '');
    const [text, setText] = useState(existing && existing.text !== existing.title ? existing.text : '');
    const [occasion, setOccasion] = useState(g?.occasion || '');
    const [date, setDate] = useState(() => (g?.givenAt ? getLocalDateKey(new Date(g.givenAt)) : space.todayKey));
    const [plannedFor, setPlannedFor] = useState(g?.plannedFor || '');
    const [productName, setProductName] = useState(g?.productName || '');
    const [photos, setPhotos] = useState<string[]>(g?.photos || []);
    const [picking, setPicking] = useState(false);
    const [products, setProducts] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!planned) return;
        DB.getAllMallProducts().then(ps => setProducts(ps.map(p => p.name))).catch(() => undefined);
    }, [planned]);
    const anniversaries = useMemo(() => (planned && events ? upcomingAnniversaries(events, { charIds: [space.char.id], personaKey: space.personaKey }, space.todayKey, 4) : []), [planned, events, space]);
    const productHits = useMemo(() => {
        const q = productName.trim();
        return q ? products.filter(p => p.includes(q) && p !== q).slice(0, 5) : [];
    }, [products, productName]);

    const save = async () => {
        if (!title.trim()) return;
        setBusy(true);
        try {
            const givenAt = Date.parse(`${date}T12:00:00`);
            let e: BondEntry;
            if (existing) {
                e = patchGift({ ...existing, title: title.trim(), text: text.trim() || title.trim(), updatedAt: Date.now() }, {
                    occasion: occasion || undefined, photos: photos.length ? photos : undefined,
                    ...(planned ? { plannedFor: plannedFor || undefined, productName: productName.trim() || undefined } : { dir, ...(g?.state === 'given' && Number.isFinite(givenAt) ? { givenAt } : {}) }),
                });
            } else {
                e = newGift({
                    bondId: space.id, dir: planned ? 'out' : dir, state: planned ? 'planned' : 'given', title: title.trim(), text: text.trim() || title.trim(),
                    occasion, photos, plannedFor: plannedFor || undefined, productName: productName.trim() || undefined, fromWishId: fromWish?.id,
                    givenAt: Number.isFinite(givenAt) ? givenAt : undefined,
                });
                trackEvent('羁绊礼物', { 动作: planned ? '打算' : '记下', 方向: (planned ? 'out' : dir) === 'out' ? '我送' : 'TA送', 来源: '手记' });
            }
            const saved = await saveBondEntry(e);
            void refreshAchievements(space).catch(() => undefined);
            addToast(existing ? '改好了' : planned ? `記下了，只有你看得到` : '記下了', 'success');
            onDone(`e:${saved.id}`);
        } catch (err: any) {
            addToast(`沒存成功：${err?.message || err}`, 'error');
            setBusy(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={existing ? '改這件禮物' : planned ? '打算送' : '記一件禮物'} onBack={onBack} backLabel="取消" />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                {planned && <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">打算送的只有你看得到，{name}不會知道；買了、送出了才會。{fromWish ? `（從${name}的願望來的）` : ''}</p>}
                {!planned && (
                    <section>
                        <SectionLabel>誰 送 誰</SectionLabel>
                        <div className="flex gap-2">
                            <button type="button" className="bond-chip" aria-pressed={dir === 'out'} onClick={() => setDir('out')}>我送{name}</button>
                            <button type="button" className="bond-chip" aria-pressed={dir === 'in'} onClick={() => setDir('in')}>{name}送我</button>
                        </div>
                    </section>
                )}
                <section>
                    <SectionLabel>是 什 麼</SectionLabel>
                    <input className="bond-input bond-serif" value={title} maxLength={40} placeholder={planned ? '像「一張黑膠唱片」' : '像「手織的圍巾」「一首寫給你的歌」'} onChange={e => setTitle(e.target.value)} />
                    <textarea className="bond-input mt-2 min-h-[70px] text-[13px]" value={text} maxLength={200} placeholder="想多寫幾句的話（可以不填）" onChange={e => setText(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>場 合</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {GIFT_OCCASIONS.map(o => <button key={o} type="button" className="bond-chip" aria-pressed={occasion === o} onClick={() => setOccasion(occasion === o ? '' : o)}>{o}</button>)}
                    </div>
                </section>
                {planned ? (
                    <>
                        <section>
                            <SectionLabel>打 算 哪 天 送</SectionLabel>
                            <input type="date" className="bond-input" value={plannedFor} min={space.todayKey} onChange={e => setPlannedFor(e.target.value)} />
                            {anniversaries.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {anniversaries.map(a => (
                                        <button key={a.event.id + a.date} type="button" className="bond-chip" aria-pressed={plannedFor === a.date}
                                            onClick={() => { setPlannedFor(a.date); if (!occasion) setOccasion(/生日/.test(a.event.title) ? '生日' : '紀念日'); }}>
                                            {a.event.title}・{Number(a.date.slice(5, 7))}/{Number(a.date.slice(8, 10))}
                                        </button>
                                    ))}
                                </div>
                            )}
                            <p className="mt-1.5 text-[11px] text-[var(--bond-muted)]">可以不填；填了，前三天提醒你一次。</p>
                        </section>
                        <section>
                            <SectionLabel>購 物 中 心 的 哪 件</SectionLabel>
                            <input className="bond-input" value={productName} placeholder="可以不填；填了，買了會自己連上" onChange={e => setProductName(e.target.value)} />
                            {productHits.length > 0 && (
                                <div className="mt-2 flex flex-wrap gap-2">{productHits.map(p => <button key={p} type="button" className="bond-chip" onClick={() => setProductName(p)}>{p}</button>)}</div>
                            )}
                        </section>
                    </>
                ) : (
                    <section>
                        <SectionLabel>哪 一 天</SectionLabel>
                        <input type="date" className="bond-input" value={date} max={space.todayKey} onChange={e => setDate(e.target.value)} />
                    </section>
                )}
                <section>
                    <SectionLabel right={<button type="button" className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1" onClick={() => setPicking(true)}><Images size={12} />從資料庫挑</button>}>照 片</SectionLabel>
                    {photos.length ? <BondPhotoStrip galleryIds={photos} size="sm" /> : <p className="text-[12px] text-[var(--bond-muted)]">可以不放；之後在禮物頁也能生一張。</p>}
                </section>
                {existing && (
                    <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4"
                        onClick={async () => { await deleteBondEntries([existing.id]); addToast('刪掉了', 'success'); onBack(); }}>刪掉這件</button>
                )}
            </div>
            <Footer>
                <button type="button" className="bond-btn flex-1" onClick={onBack}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !title.trim()} onClick={save}>{busy ? '存檔中…' : '存'}</button>
            </Footer>
            {picking && <BondPhotoPicker initial={photos} onBack={() => setPicking(false)} onDone={ids => { setPhotos(ids); setPicking(false); }} />}
        </div>
    );
};
