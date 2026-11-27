/**
 * 事件卡的全螢幕頁（plans/bond-batch4.md 2.2～2.5、4.2）：
 * 主題、會帶進去的願望與回憶（可以勾掉）、在哪演、開演；演過的整理結果、你選成了／還沒／換個方向；先放著。
 * 另有自訂事件卡（只能記里程碑，不改階段）、同步承認卡（首頁用）。
 */
import { useGiftViews } from './BondTreasurePage';
import { giftSceneText, giftsForScene } from '../../utils/bond/gift';
import React, { useEffect, useMemo, useState } from 'react';
import { ChatCircleText, Check, Coffee, Flag, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, BondSyncProposal, CharacterProfile } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries, useSpaceTimeline } from './useSpaceTimeline';
import { useBondLedger } from './useBondLedger';
import { cardAvailability, cardDef, cardsForRoute, SYNC_KINDS, type EventCardDef } from '../../utils/bond/eventCards';
import { levelInfo } from '../../utils/bond/level';
import { totalPoints } from '../../utils/bond/ledger';
import { stageLabel, stagesOf } from '../../utils/bond/routes';
import { milestoneLabel } from '../../utils/bond/pact';
import { formatEventDate } from '../../utils/bond/eventDate';
import { saveBondEntry } from '../../utils/bond/entries';
import { acceptSync, applyCardResult, createCustomCard, judgeCard, rejectSync, setAsideCard, startInChat, startInDate, type CardJudge } from './eventCardRun';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const VENUE_LABEL = { chat: '私聊', date: '見面' } as const;
const STATE_LABEL = { locked: '還沒解鎖', unlocked: '可以演', playing: '演出中', done: '演過了', setAside: '先放著' } as const;
const RESULT_LABEL = { yes: '成了', notYet: '還沒', other: '換了個方向' } as const;

/** 里程碑頁裡的事件卡清單：解鎖的、演出中、放著的、鎖著的（看得到名字和解鎖等級）、演過的 */
export const EventCardList: React.FC<{ space: ResolvedSpace; onOpen: (key: string) => void; onNewCustom: () => void }> = ({ space, onOpen, onNewCustom }) => {
    const entries = useBondEntries(space.id);
    const ledger = useBondLedger(space.id);
    const level = levelInfo(totalPoints(ledger)).level;
    const hurt = !!space.bond.feeling?.openHurts.some(h => !h.repairedAt);
    const cards = entries.filter(e => e.kind === 'eventCard' && e.eventCard);
    const byCardId = new Map(cards.map(c => [c.eventCard!.cardId, c]));
    const rows: Array<{ key: string; title: string; state: keyof typeof STATE_LABEL; note: string; fresh?: boolean; blocked?: boolean }> = [];
    for (const def of cardsForRoute(space.bond.route)) {
        const e = byCardId.get(def.id);
        if (!e) { rows.push({ key: `def:${def.id}`, title: def.title, state: 'locked', note: `Lv.${def.unlock} 解鎖` }); continue; }
        const av = cardAvailability(def, { level, stage: space.bond.stage, hasOpenHurt: hurt });
        const note = e.eventCard!.state === 'done' ? RESULT_LABEL[e.eventCard!.outcome?.result || 'yes']
            : av === 'hurt' ? '先把沒修好的事談開' : av === 'stage' ? `要在「${def.from!.map(s => stagesOf(space.bond.route).find(o => o.id === s)?.label || s).join('／')}」的時候` : VENUE_LABEL[e.eventCard!.venue || def.venue];
        rows.push({ key: e.id, title: def.title, state: e.eventCard!.state, note, fresh: !e.seenAt && e.eventCard!.state === 'unlocked', blocked: av !== 'ok' && e.eventCard!.state !== 'done' });
    }
    for (const e of cards.filter(c => c.eventCard!.cardId === 'custom')) rows.push({ key: e.id, title: e.title || '自訂', state: e.eventCard!.state, note: `自訂 · ${VENUE_LABEL[e.eventCard!.venue || 'chat']}` });
    const order: Record<string, number> = { playing: 0, unlocked: 1, setAside: 2, locked: 3, done: 4 };
    rows.sort((a, b) => order[a.state] - order[b.state]);
    return (
        <section className="mt-6">
            <SectionLabel right={<button type="button" className="text-[11.5px] text-[var(--bond-accent)]" onClick={onNewCustom}>自訂一張</button>}>事 件 卡</SectionLabel>
            <p className="mb-2 text-[11px] text-[var(--bond-muted)]">等級只解鎖機會、不換身份；演成了由你確認，才會記下來、改階段。</p>
            <div className="divide-y bond-hair border-y">
                {rows.map(r => (
                    <button key={r.key} type="button" onClick={() => onOpen(r.key)} className={`w-full py-3 flex items-center justify-between gap-3 text-left ${r.state === 'locked' ? 'opacity-55' : ''}`}>
                        <span className="bond-serif text-[14px]">{r.title}{r.fresh && <span className="ml-1.5 text-[10.5px] text-[var(--bond-accent)]">新</span>}</span>
                        <span className="text-[11px] text-[var(--bond-muted)] shrink-0">{r.blocked ? '還不能演' : STATE_LABEL[r.state]} · {r.note}</span>
                    </button>
                ))}
            </div>
        </section>
    );
};

export const BondEventCardPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    cardKey: string;
    onBack: () => void;
    /** 在私聊開演：開那條線的私聊 */
    onGoChat: () => void;
    /** 在見面開演：把大綱放進下一場、開見面 */
    onGoDate: (scenario: string) => void;
    onOpenFeeling: () => void;
    addToast: Toast;
}> = ({ space, characters, apiConfig, cardKey, onBack, onGoChat, onGoDate, onOpenFeeling, addToast }) => {
    const entries = useBondEntries(space.id);
    const ledger = useBondLedger(space.id);
    const { items } = useSpaceTimeline(space, characters);
    const card = cardKey.startsWith('def:') ? undefined : entries.find(e => e.id === cardKey);
    const def: EventCardDef | undefined = card ? cardDef(card.eventCard!.cardId) : cardDef(cardKey.slice(4));
    const level = levelInfo(totalPoints(ledger)).level;
    const hurt = !!space.bond.feeling?.openHurts.some(h => !h.repairedAt);
    const av = def ? cardAvailability(def, { level, stage: space.bond.stage, hasOpenHurt: hurt }) : 'ok';
    const wishes = useMemo(() => entries.filter(e => e.kind === 'wish' && e.status === 'published' && e.wish?.state !== 'done' && e.wish?.state !== 'shelved'), [entries]);
    const moments = useMemo(() => items.filter(i => !i.hidden && i.kind !== 'essay').slice(0, 8), [items]);
    const [wishIds, setWishIds] = useState<string[] | null>(null);
    const [itemKeys, setItemKeys] = useState<string[] | null>(null);
    // 珍藏（第 5 批）：跟這一刻相關的禮物（場合對得上的、求婚告白帶飾品），預設帶 2 件、可以勾掉
    const { views: giftViews } = useGiftViews(space);
    const giftChoices = useMemo(() => (space.kind === 'persona' ? giftViews.filter(v => !v.secret && v.state !== 'planned').slice(0, 8) : []), [giftViews, space.kind]);
    const [giftKeys, setGiftKeys] = useState<string[] | null>(null);
    const [venue, setVenue] = useState<'chat' | 'date'>(card?.eventCard?.venue || def?.venue || 'chat');
    const [busy, setBusy] = useState(false);
    const [judge, setJudge] = useState<CardJudge | null>(null);
    const [pick, setPick] = useState<'yes' | 'notYet' | 'other'>('yes');
    const [note, setNote] = useState('');
    const [changeStage, setChangeStage] = useState(true);
    const [anniversary, setAnniversary] = useState(!!def?.result.anniversary);

    useEffect(() => { if (card && !card.seenAt) void saveBondEntry({ ...card, seenAt: Date.now() }); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [card?.id]);
    // 預設帶最相關的：願望全勾、回憶勾收藏的或最近兩件
    const wishPick = wishIds ?? wishes.slice(0, 3).map(w => w.id);
    const itemPick = itemKeys ?? (moments.filter(m => m.favorite).slice(0, 3).map(m => m.key).concat(moments.slice(0, 2).map(m => m.key))).filter((k, i, a) => a.indexOf(k) === i).slice(0, 3);
    const title = card?.title || def?.title || '事件卡';
    const theme = card?.text || def?.theme || '';
    const giftPick = giftKeys ?? giftsForScene(giftChoices, { title, theme }).map(v => v.key);
    const ec = card?.eventCard;

    const start = async () => {
        if (!card) return;
        setBusy(true);
        try {
            const picks = {
                wishIds: wishPick, itemTexts: moments.filter(m => itemPick.includes(m.key)).map(m => ({ key: m.key, text: (m.title ? `${m.title}：` : '') + m.text })),
                giftTexts: giftChoices.filter(v => giftPick.includes(v.key)).map(v => ({ key: v.key, text: giftSceneText(v, space.leftName) })),
            };
            if (venue === 'chat') {
                await startInChat(space, card, picks);
                addToast('下一輪私聊會帶著這一刻', 'success');
                onGoChat();
            } else {
                const scenario = await startInDate(space, card, picks);
                addToast('放進下一場見面的大綱了，開一場新的見面就會帶著', 'success');
                onGoDate(scenario);
            }
        } catch (e: any) {
            addToast(`沒開成：${e?.message || e}`, 'error');
        } finally { setBusy(false); }
    };
    const runJudge = async () => {
        if (!card) return;
        setBusy(true);
        try {
            const j = await judgeCard(space, card, apiConfig);
            setJudge(j); setPick(j.result); setNote(j.summary);
        } catch (e: any) { addToast(e?.message || '沒整理出來', 'error'); }
        finally { setBusy(false); }
    };
    const confirm = async () => {
        if (!card) return;
        await applyCardResult(space, card, { result: pick, note, messageIds: judge?.messageIds, changeStage: !!def?.result.stageTo && (def.result.stageOptional ? changeStage : true), anniversary: pick === 'yes' && anniversary });
        setJudge(null);
        addToast(pick === 'yes' ? '記下來了' : pick === 'notYet' ? '好，之後可以再演' : '好，就這樣', 'success');
        if (pick !== 'notYet') onBack();
    };

    const stageName = (id?: string) => (id ? stagesOf(space.bond.route).find(o => o.id === id)?.label || id : '');

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="事件卡" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <article className="px-6 pt-7 pb-6 border-b bond-hair">
                    <div className="bond-note">{ec ? STATE_LABEL[ec.state] : `Lv.${def?.unlock} 解鎖`}{def?.from ? ` · 要在「${def.from.map(stageName).join('／')}」的時候` : ''}</div>
                    <div className="bond-serif mt-3 text-[22px] tracking-wide">{title}</div>
                    <div className="bond-serif mt-3 text-[14.5px] leading-relaxed text-[var(--bond-ink-2)]">{theme}</div>
                    {def && (
                        <div className="mt-3 text-[11.5px] text-[var(--bond-muted)] leading-relaxed">
                            演成了：記里程碑「{def.result.milestoneTitle || milestoneLabel(def.result.milestone)}」
                            {def.result.stageTo ? `，${def.result.stageOptional ? '可以' : ''}把階段改成「${stageName(def.result.stageTo)}」` : ''}
                            {def.result.habit ? '，記一條默契' : ''}{def.result.anniversary ? '，可以記成紀念日' : ''}{def.result.repair ? '，那件沒修好的事標成修好了' : ''}。
                        </div>
                    )}
                </article>

                <div className="px-5 py-6 space-y-7">
                    {!card && <p className="text-[12.5px] text-[var(--bond-muted)]">你們到 Lv.{def?.unlock} 會解鎖這張卡（現在 Lv.{level}）。</p>}

                    {card && av === 'hurt' && (
                        <section className="rounded-xl border bond-hair bg-[var(--bond-accent-soft)] px-4 py-3">
                            <div className="text-[13px]">先把沒修好的事談開，這張卡才開放演。</div>
                            <button type="button" className="mt-2 text-[11.5px] text-[var(--bond-accent)]" onClick={onOpenFeeling}>看那件事 ›</button>
                        </section>
                    )}
                    {card && av === 'stage' && <p className="text-[12.5px] text-[var(--bond-muted)]">現在是「{stageLabel(space.bond)}」；要在「{def!.from!.map(stageName).join('／')}」的時候才演得了。</p>}

                    {card && (ec!.state === 'unlocked' || ec!.state === 'setAside') && av === 'ok' && (
                        <>
                            {wishes.length > 0 && (
                                <section>
                                    <SectionLabel>帶 進 去 的 願 望</SectionLabel>
                                    <div className="flex flex-wrap gap-2">
                                        {wishes.map(w => {
                                            const on = wishPick.includes(w.id);
                                            return <button key={w.id} type="button" className="bond-chip" aria-pressed={on} onClick={() => setWishIds(on ? wishPick.filter(x => x !== w.id) : [...wishPick, w.id])}>{w.text.slice(0, 18)}</button>;
                                        })}
                                    </div>
                                </section>
                            )}
                            {moments.length > 0 && (
                                <section>
                                    <SectionLabel>帶 進 去 的 回 憶</SectionLabel>
                                    <div className="divide-y bond-hair border-y">
                                        {moments.map(m => {
                                            const on = itemPick.includes(m.key);
                                            return (
                                                <button key={m.key} type="button" aria-pressed={on} onClick={() => setItemKeys(on ? itemPick.filter(x => x !== m.key) : [...itemPick, m.key])} className="w-full py-2.5 flex gap-3 text-left">
                                                    <span className={`mt-0.5 h-4 w-4 shrink-0 rounded border bond-hair grid place-items-center ${on ? 'bg-[var(--bond-accent)] text-white' : ''}`}>{on && <Check size={11} />}</span>
                                                    <span className="min-w-0 text-[12.5px] leading-relaxed"><span className="text-[var(--bond-muted)]">{formatEventDate(m.eventDate)}　</span>{((m.title ? `${m.title}：` : '') + m.text).slice(0, 60)}</span>
                                                </button>
                                            );
                                        })}
                                    </div>
                                </section>
                            )}
                            {giftChoices.length > 0 && (
                                <section>
                                    <SectionLabel>帶 進 去 的 禮 物</SectionLabel>
                                    <div className="flex flex-wrap gap-2">
                                        {giftChoices.map(v => {
                                            const on = giftPick.includes(v.key);
                                            return <button key={v.key} type="button" className="bond-chip" aria-pressed={on} onClick={() => setGiftKeys(on ? giftPick.filter(x => x !== v.key) : [...giftPick, v.key])}>{v.dir === 'out' ? '你送的' : `${space.rightName}送的`}・{v.title.slice(0, 14)}</button>;
                                        })}
                                    </div>
                                </section>
                            )}
                            <section>
                                <SectionLabel>在 哪 演</SectionLabel>
                                <div className="flex gap-2">
                                    {(['chat', 'date'] as const).map(v => <button key={v} type="button" className="bond-chip" aria-pressed={venue === v} onClick={() => setVenue(v)}>{VENUE_LABEL[v]}</button>)}
                                </div>
                                <p className="mt-1.5 text-[11px] text-[var(--bond-muted)]">{venue === 'chat' ? `下一輪私聊會帶著這一刻（只帶一輪），${space.rightName}照自己的方式開口或回應——可能猶豫、可能拒絕、可能要時間。` : '放進下一場見面的大綱；開一場新的見面就會從這一刻開始。'}</p>
                            </section>
                            <section className="flex flex-wrap gap-2">
                                <button type="button" className="bond-btn bond-btn-primary" disabled={busy} onClick={start}>{venue === 'chat' ? <ChatCircleText size={14} /> : <Coffee size={14} />}開演</button>
                                {ec!.state === 'setAside'
                                    ? <button type="button" className="bond-btn" onClick={() => setAsideCard(space, card, false)}>拿出來</button>
                                    : <button type="button" className="bond-btn" onClick={() => { void setAsideCard(space, card, true); addToast('先放著，不急', 'info'); }}>先放著</button>}
                            </section>
                        </>
                    )}

                    {card && ec!.state === 'playing' && (
                        <section>
                            <SectionLabel>演 完 了 嗎</SectionLabel>
                            <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">在{VENUE_LABEL[ec!.venue || 'chat']}演完了，讓 AI 讀從開演到現在的那段，整理一句結果；你決定算不算。</p>
                            {!judge ? (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button type="button" className="bond-btn bond-btn-primary" disabled={busy} onClick={runJudge}><Sparkle size={14} />{busy ? '讀那段中…' : '演完了，整理一下'}</button>
                                    <button type="button" className="bond-btn" onClick={() => setJudge({ result: 'yes', summary: '', messageIds: [] })}>自己選結果</button>
                                    {ec!.venue === 'chat' ? <button type="button" className="bond-btn" onClick={onGoChat}>回私聊</button> : <button type="button" className="bond-btn" onClick={() => onGoDate('')}>回見面</button>}
                                </div>
                            ) : (
                                <div className="mt-3 rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-4 space-y-3">
                                    <div className="flex gap-2">
                                        {(['yes', 'notYet', 'other'] as const).map(r => <button key={r} type="button" className="bond-chip" aria-pressed={pick === r} onClick={() => setPick(r)}>{RESULT_LABEL[r]}</button>)}
                                    </div>
                                    <textarea className="bond-input bond-serif min-h-[70px] leading-relaxed" value={note} placeholder="發生了什麼（會寫進里程碑）" onChange={e => setNote(e.target.value)} />
                                    {judge.messageIds.length > 0 && <div className="text-[11px] text-[var(--bond-muted)]">依據 {judge.messageIds.length} 則訊息</div>}
                                    {pick === 'yes' && def?.result.stageTo && def.result.stageOptional && (
                                        <button type="button" className="bond-chip" aria-pressed={changeStage} onClick={() => setChangeStage(!changeStage)}>也把階段改成「{stageName(def.result.stageTo)}」</button>
                                    )}
                                    {pick === 'yes' && def?.result.stageTo && !def.result.stageOptional && <p className="text-[11.5px] text-[var(--bond-ink-2)]">階段會從「{stageLabel(space.bond)}」改成「{stageName(def.result.stageTo)}」，寫進路線歷程。</p>}
                                    {pick === 'yes' && <button type="button" className="bond-chip" aria-pressed={anniversary} onClick={() => setAnniversary(!anniversary)}>記成紀念日（每年提醒，{space.rightName}也會記得）</button>}
                                    <div className="flex gap-2">
                                        <button type="button" className="bond-btn" onClick={() => setJudge(null)}>先不要</button>
                                        <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={confirm}><Flag size={14} />確定</button>
                                    </div>
                                </div>
                            )}
                        </section>
                    )}

                    {ec?.history?.length ? (
                        <section>
                            <SectionLabel>演 過 的</SectionLabel>
                            <div className="divide-y bond-hair border-y">
                                {[...ec.history].reverse().map((h, i) => (
                                    <div key={i} className="py-2.5 text-[12.5px]">
                                        <span className="text-[var(--bond-muted)]">{new Date(h.at).toLocaleDateString()} · {VENUE_LABEL[h.venue || 'chat']} · </span>{RESULT_LABEL[h.result]}
                                        {h.note && <div className="mt-0.5 bond-serif text-[13px] leading-relaxed">{h.note}</div>}
                                    </div>
                                ))}
                            </div>
                        </section>
                    ) : null}
                </div>
            </div>
        </div>
    );
};

export const BondCustomCardPage: React.FC<{ space: ResolvedSpace; onBack: () => void; onDone: (id: string) => void }> = ({ space, onBack, onDone }) => {
    const [title, setTitle] = useState('');
    const [theme, setTheme] = useState('');
    const [venue, setVenue] = useState<'chat' | 'date'>('chat');
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="自訂事件卡" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <section>
                    <SectionLabel>叫 什 麼</SectionLabel>
                    <input className="bond-input" value={title} maxLength={20} placeholder="第一次一起看日出" onChange={e => setTitle(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>是 什 麼 樣 的 時 刻</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[90px]" value={theme} placeholder="天還沒亮就出門，在山上等太陽出來" onChange={e => setTheme(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>在 哪 演</SectionLabel>
                    <div className="flex gap-2">{(['chat', 'date'] as const).map(v => <button key={v} type="button" className="bond-chip" aria-pressed={venue === v} onClick={() => setVenue(v)}>{VENUE_LABEL[v]}</button>)}</div>
                </section>
                <p className="text-[11px] text-[var(--bond-muted)]">自訂的卡演成了只記里程碑；要改階段去路線頁。</p>
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn bond-btn-primary w-full justify-center" disabled={!title.trim() || !theme.trim()}
                    onClick={async () => onDone((await createCustomCard(space.id, { title, theme, venue })).id)}>做好了</button>
            </div>
        </div>
    );
};

/** 首頁的同步承認卡：「看起來你們 11 月 26 日在一起了，要記下來嗎？」 */
export const SyncProposalCard: React.FC<{ space: ResolvedSpace; p: BondSyncProposal; onOpenSource?: (p: BondSyncProposal) => void; addToast: Toast }> = ({ space, p, onOpenSource, addToast }) => {
    const [anniversary, setAnniversary] = useState(p.what !== 'reconciled');
    const [busy, setBusy] = useState(false);
    const label = SYNC_KINDS[p.what]?.label || p.what;
    const day = p.date ? `${Number(p.date.slice(5, 7))} 月 ${Number(p.date.slice(8, 10))} 日` : '最近';
    const stageName = (id?: string) => (id ? stagesOf(p.routeTo || space.bond.route).find(o => o.id === id)?.label || id : '');
    return (
        <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3.5">
            <div className="text-[13.5px] leading-relaxed">
                {p.source === 'story'
                    ? <>這一章裡{space.kind === 'pair' ? '他們' : '你們'}<span className="bond-serif text-[var(--bond-accent)]">〈{label}〉</span>，要記成{space.kind === 'pair' ? '他們' : '你們'}現在的{p.stageTo ? '階段' : '里程碑'}嗎？</>
                    : <>看起來{space.kind === 'pair' ? '他們' : '你們'}{day}<span className="bond-serif text-[var(--bond-accent)]">{label}</span>，要記下來嗎？</>}
            </div>
            <div className="mt-1 bond-serif text-[13px] leading-relaxed text-[var(--bond-ink-2)]">「{p.text}」</div>
            <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">
                {p.routeTo ? `會把路線設成${p.routeTo === 'romance' ? '戀愛' : '友情'}、` : ''}{p.stageTo ? `階段改成「${stageName(p.stageTo)}」、` : ''}記一個里程碑（依據是{p.source === 'summary' ? '那天的總結' : p.source === 'story' ? '那一章故事' : '那段聊天'}）{p.source === 'story' ? '；按「不是」只留下片刻' : ''}
                {onOpenSource && <button type="button" className="ml-1 text-[var(--bond-accent)]" onClick={() => onOpenSource(p)}>看原文 ›</button>}
            </div>
            <button type="button" className="bond-chip mt-2" aria-pressed={anniversary} onClick={() => setAnniversary(!anniversary)}>同時記成紀念日</button>
            <div className="mt-3 flex gap-2">
                <button type="button" className="bond-btn bond-btn-primary" disabled={busy} onClick={async () => { setBusy(true); await acceptSync(space, p, anniversary); addToast('記下來了', 'success'); }}>對</button>
                <button type="button" className="bond-btn" disabled={busy} onClick={async () => { setBusy(true); await rejectSync(space, p); }}>不是</button>
            </div>
        </div>
    );
};
