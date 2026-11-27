/**
 * 一段關係的首頁「我們」（plans/bond-batch1.md 3.3，2026-11-27 照 Liora 的 wireframe 改成色塊分區，plans/bond-look.md）：
 * 主視覺色塊（兩人、路線階段、天數、此刻的一句、等級與下一個里程碑）→ 等你接住（淡粉）→ 紀念日、最近拾光、此刻的我們、
 * 親近與信任（白卡）→ 近期約定一行一個；角色 × 角色多一塊「他們怎麼看對方」和私聊整理時自動留日記的開關。
 */
import React, { useMemo, useState } from 'react';
import { CalendarBlank, CaretRight, EnvelopeSimple, Gift, Hourglass, LinkSimple, PencilSimple, Sparkle, type Icon } from '@phosphor-icons/react';
import type { APIConfig, BondSyncProposal, CalendarEvent, CharacterProfile } from '../../types';
import { BondAvatar, BondHeader } from './bondUi';
import { patchGift, plansDueSoon } from '../../utils/bond/gift';
import { saveBondEntry } from '../../utils/bond/entries';
import { useHeartNotice, type HeartNotice } from './BondHeartPage';
import type { ResolvedSpace } from './space';
import { ROUTE_LABEL, routeLabel, stageLabel, suggestBond } from '../../utils/bond/routes';
import { applyRouteChange } from '../../utils/bond/model';
import { nextAnniversary, primaryCounter } from '../../utils/bond/spaces';
import { saveBondRecord, updateBond } from '../../utils/bond/store';
import { generateOurNow } from '../../utils/bond/ourNow';
import { loadPairMessages } from '../../utils/pairChatRun';
import { pairTranscript } from '../../utils/pairLine';
import { trackEvent } from '../../utils/analytics';
import { useSpaceTimeline } from './useSpaceTimeline';
import { itemHeadline } from './BondMomentsPage';
import { pickRecentItem, type TimelineItem } from '../../utils/bond/timeline';
import { formatEventDate } from '../../utils/bond/eventDate';
import { useBondLedger } from './useBondLedger';
import { useBondEntries } from './useSpaceTimeline';
import { levelInfo } from '../../utils/bond/level';
import { nextCardToUnlock } from '../../utils/bond/eventCards';
import { FeelingBars } from './BondFeelingPage';
import { SyncProposalCard } from './BondEventCardPages';
import { donePeriod, ledgerKeyOf, promiseStartDay, totalPoints } from '../../utils/bond/ledger';
import { countsOnDay, dayKeyOf, periodKeyOf, periodWord } from '../../utils/bond/period';
import { promiseWaitingOn } from '../../utils/bond/pact';

export const BondSpacePage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    events: CalendarEvent[];
    apiConfig: APIConfig;
    onBack: () => void;
    onOpenRoute: () => void;
    onOpenDays: () => void;
    onEditMine: () => void;
    onAddAnniversary: () => void;
    /** 分頁列（我們／拾光） */
    tabBar?: React.ReactNode;
    /** 首頁「最近拾光」點了去那一件 */
    onOpenItem?: (key: string) => void;
    /** 首頁「最近值得留意的一件事」點了去那一則（plans/bond-batch3.md 3.3） */
    onOpenNotice?: (n: HeartNotice) => void;
    /** 約定（plans/bond-batch4.md 4.3）：Lv. 點了去里程碑頁、近期約定點了去那個約定 */
    onOpenPact?: (to: { tab: 'promise' | 'milestone'; promiseId?: string }) => void;
    /** 珍藏（第 5 批）：打算送的快到了，點了開那件 */
    onOpenGift?: (key: string) => void;
    /** 留給以後到期了：點了開那封 */
    onOpenCapsule?: (id: string) => void;
    /** 親近與信任（plans/bond-batch4.md 4.1） */
    onOpenFeeling?: () => void;
    /** 同步承認的依據：跳回那段聊天或那天的總結 */
    onOpenSyncSource?: (p: BondSyncProposal) => void;
    /** 角色之間：承認卡「看原文」開那一章 */
    onOpenStory?: (entryId: string) => void;
    /** 角色之間：他們的故事與讀者視角概覽（plans/bond-batch6.md 第 1 節），放在主視覺下面第一塊 */
    storySlot?: React.ReactNode;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, characters, events, apiConfig, onBack, onOpenRoute, onOpenDays, onEditMine, onAddAnniversary, tabBar, onOpenItem, onOpenNotice, onOpenPact, onOpenGift, onOpenCapsule, onOpenFeeling, onOpenSyncSource, onOpenStory, storySlot, addToast }) => {
    const notice = useHeartNotice(space);
    const ledger = useBondLedger(space.id);
    const pactEntries = useBondEntries(space.id);
    const points = useMemo(() => totalPoints(ledger), [ledger]);
    // 打算送的那天前三天提醒（plans/bond-batch5.md 2.3）；按「知道了」就不再出
    const dueGifts = useMemo(() => plansDueSoon(pactEntries, space.todayKey).filter(e => !e.gift?.remindedAt), [pactEntries, space.todayKey]);
    // 留給以後：條件到了、還沒拆的（一起打開的只列你那封）
    const dueCapsules = useMemo(() => pactEntries.filter(e => e.kind === 'capsule' && e.capsule?.dueAt && !e.capsule.openedAt && !(e.author !== 'user' && e.capsule.pairWith)), [pactEntries]);
    const freshCards = useMemo(() => pactEntries.filter(e => e.kind === 'eventCard' && e.eventCard?.state === 'unlocked' && !e.seenAt), [pactEntries]);
    // 近期共同約定（紀要 7.3 第 5 點）：這期還沒做的、TA 提了在等你的，最多 3 個
    const upcoming = useMemo(() => {
        if (space.kind !== 'persona') return [];
        const today = dayKeyOf(Date.now());
        return pactEntries.filter(e => e.kind === 'promise' && e.promise).flatMap(e => {
            const pr = e.promise!;
            if (promiseWaitingOn(e) === 'user') return [{ e, note: `${space.rightName}提的，等你說好` }];
            if (pr.state !== 'active' || pr.repeat.kind === 'once' || !countsOnDay(pr.repeat, today)) return [];
            const done = donePeriod(ledger, ledgerKeyOf(e), periodKeyOf(pr.repeat, today, promiseStartDay(e) || undefined));
            return done ? [] : [{ e, note: `${periodWord(pr.repeat)}還沒` }];
        }).slice(0, 3);
    }, [pactEntries, ledger, space]);
    // 最近拾光（plans/bond-batch2.md 第 7 節）：收藏的優先，沒有就最新的；什麼都沒有時不顯示這塊
    const { items: timelineItems } = useSpaceTimeline(space, characters);
    const recent = useMemo(() => pickRecentItem(timelineItems), [timelineItems]);
    const [bond, setBond] = useState(space.bond);
    const [busy, setBusy] = useState<string | null>(null);
    const isPair = space.kind === 'pair';
    const counter = primaryCounter(bond, isPair ? bond.days.metDate : space.view?.acquaintanceStartDate, space.todayKey);
    const anniversary = useMemo(() => nextAnniversary(events, {
        charIds: isPair ? [space.char.id, space.other!.id] : [space.char.id],
        personaKey: space.personaKey,
    }, space.todayKey), [events, isPair, space]);

    // 建議路線（只建議，不自動設）
    const suggestion = useMemo(() => {
        if (bond.route || bond.suggestionDismissed) return null;
        if (isPair) {
            const a = space.char.relationships?.find(r => r.targetId === space.other!.id)?.description;
            const b = space.other!.relationships?.find(r => r.targetId === space.char.id)?.description;
            return suggestBond([a, b]);
        }
        const v = space.view!;
        const toUser = v.relationships?.find(r => r.targetId === 'user')?.description;
        return suggestBond([v.userViewRelationship, v.charViewRelationship, toUser]);
    }, [bond.route, bond.suggestionDismissed, isPair, space]);

    const acceptSuggestion = async () => {
        if (!suggestion) return;
        const next = applyRouteChange(bond, { route: suggestion.route, stage: suggestion.stage, stageLabel: suggestion.label }, { kind: 'fix', storyDay: space.todayKey });
        setBond(await saveBondRecord(next.openedBy === 'auto' ? { ...next, openedBy: 'user' } : next));
        trackEvent('设定羁绊路线', { 路线: suggestion.route === 'romance' ? '恋爱' : '亲情', 方式: '修正', 类型: isPair ? '角色之间' : '我和角色' });
    };
    const dismissSuggestion = async () => setBond(await updateBond(space.id, b => ({ ...b, suggestionDismissed: true })));

    // 此刻的我們：誰寫（persona：角色；pair：左邊或右邊那位）
    const writeOurNow = async (who: 'char' | 'other') => {
        const writer = who === 'other' ? space.other! : space.char;
        const counterpart = who === 'other' ? space.char : space.other;
        setBusy(who);
        try {
            const recent = isPair && counterpart
                ? pairTranscript((await loadPairMessages(space.char.id, space.other!.id)).slice(-40), writer.id).slice(-4000)
                : '';
            const text = await generateOurNow({
                char: isPair ? writer : space.view!,
                user: space.user || { name: counterpart?.name || '', avatar: '', bio: '' } as any,
                personaKey: space.personaKey,
                bond,
                apiConfig,
                ...(isPair && counterpart ? { pair: { other: counterpart, recent } } : {}),
            });
            // pair：space.char 就是 bond.charId 那位（id 照字典序），存 char；另一位存 other
            setBond(await updateBond(space.id, b => ({ ...b, ourNow: { ...(b.ourNow || {}), [who]: { text, at: Date.now() } } })));
            trackEvent('生成此刻的我们');
        } catch (e: any) {
            addToast(e?.message || '這次沒寫出來', 'error');
        } finally {
            setBusy(null);
        }
    };

    const toggleAutoDiary = async () => setBond(await updateBond(space.id, b => ({ ...b, pairAutoDiary: b.pairAutoDiary === false })));

    const charText = bond.ourNow?.char?.text;
    const otherText = isPair ? bond.ourNow?.other?.text : bond.ourNow?.user?.text;

    const meters = !isPair ? (space.view?.affinities || []).filter(m => typeof m.value === 'number' || m.content) : [];
    const pairViews = isPair ? [
        { from: space.char, to: space.other!, desc: space.char.relationships?.find(r => r.targetId === space.other!.id)?.description },
        { from: space.other!, to: space.char, desc: space.other!.relationships?.find(r => r.targetId === space.char.id)?.description },
    ] : [];
    const contactAffinity = (from: CharacterProfile, toId: string) => from.phoneState?.contacts?.find(c => c.linkedCharId === toId)?.affinity;

    const level = levelInfo(points);
    const nextCard = !isPair ? nextCardToUnlock(pactEntries, bond.route, level.level, bond.stage || '') : null;
    const showLevel = !isPair && !!onOpenPact;
    // 主視覺那句話：角色寫的此刻的我們，第一段
    const heroLine = (charText || '').split(/\n+/).map(t => t.trim()).find(Boolean);
    const routeLine = `${routeLabel(bond.route)}${bond.route ? '路線' : ''}`;

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={isPair ? `${space.leftName} & ${space.rightName}` : space.rightName} onBack={onBack} />
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-4 pt-1 space-y-3.5" style={{ paddingBottom: 28 }}>
                    {/* 關係主視覺：兩個人、路線與階段、天數、此刻的一句、等級 */}
                    <section className="bond-block bg-[var(--bond-block-sand)] px-5 pt-7 pb-6 text-center">
                        <div className="flex items-center justify-center gap-3">
                            <BondAvatar value={space.leftAvatar} name={space.leftName} size={60} className="ring-4 ring-[var(--bond-card)]" />
                            <LinkSimple size={22} className="text-[var(--bond-ink-2)]" aria-hidden />
                            <BondAvatar value={space.rightAvatar} name={space.rightName} size={60} className="ring-4 ring-[var(--bond-card)]" />
                        </div>
                        <button type="button" onClick={onOpenRoute} className="mt-4 inline-flex items-center gap-1 text-[13px] tracking-wide text-[var(--bond-ink-2)]">
                            {routeLine}<span className="mx-0.5 text-[var(--bond-rose)]">·</span>{stageLabel(bond)}
                            <CaretRight size={11} className="text-[var(--bond-muted)]" />
                        </button>
                        <button type="button" onClick={onOpenDays} className="mt-1 block mx-auto">
                            {counter.days !== null ? (
                                <span className="inline-flex items-baseline gap-1.5 text-[var(--bond-ink)]">
                                    <span className="text-[14px]">{counter.label}第</span>
                                    <span className="bond-serif text-[54px] leading-none tracking-tight tabular-nums">{counter.days}</span>
                                    <span className="text-[14px]">天</span>
                                </span>
                            ) : (
                                <span className="inline-block mt-2 text-[12.5px] text-[var(--bond-muted)] underline underline-offset-4 decoration-[var(--bond-line)]">填一個起點，開始算天數</span>
                            )}
                        </button>
                        {heroLine && <p className="mt-3 text-[13px] leading-relaxed text-[var(--bond-ink-2)] line-clamp-2">{heroLine}</p>}
                        {showLevel && (
                            <button type="button" onClick={() => onOpenPact!({ tab: 'milestone' })} className="mt-5 block w-full text-left" aria-label={`羈絆等級 ${level.level}`}>
                                <div className="flex items-baseline justify-between text-[13px]">
                                    <span className="text-[var(--bond-ink)]">羈絆 Lv. {level.level}</span>
                                    <span className="tabular-nums text-[var(--bond-ink-2)]">{level.points.toLocaleString()} / {level.next.toLocaleString()}</span>
                                </div>
                                <div className="mt-2 h-[7px] rounded-full bg-[var(--bond-track)] overflow-hidden">
                                    <div className="h-full rounded-full bg-[var(--bond-accent)]" style={{ width: `${Math.max(2, Math.round(level.progress * 100))}%` }} />
                                </div>
                                <div className="mt-2.5 text-center text-[12px] text-[var(--bond-ink-2)]">
                                    {nextCard ? <>下一個里程碑<span className="mx-1 text-[var(--bond-rose)]">·</span>{nextCard.title}<span className="ml-1 text-[var(--bond-muted)]">Lv.{nextCard.unlock}</span></> : '這條路線的事件卡都解鎖了'}
                                </div>
                            </button>
                        )}
                    </section>

                    {storySlot}

                    {suggestion && (
                        <section className="bond-block bg-[var(--bond-block-mist)] px-5 py-4">
                            <div className="text-[13.5px] leading-relaxed">
                                看起來{isPair ? '他們' : '你們'}是<span className="bond-serif text-[var(--bond-accent)]">{suggestion.label || stageLabel({ route: suggestion.route, stage: suggestion.stage })}</span>
                                <span className="text-[var(--bond-muted)]">（「{suggestion.from}」）</span>，要設成{ROUTE_LABEL[suggestion.route]}線嗎？
                            </div>
                            <div className="mt-3 flex gap-2">
                                <button type="button" className="bond-btn bond-btn-primary" onClick={acceptSuggestion}>設定</button>
                                <button type="button" className="bond-btn" onClick={dismissSuggestion}>不是</button>
                            </div>
                        </section>
                    )}

                    {/* 等你接住：同步承認、到期的留給以後、快到的禮物、剛解鎖的事件卡、心意的新東西 */}
                    {(bond.syncPending || []).filter(p => !isPair || p.source === 'story').map(p => (
                        <section key={p.id}><SyncProposalCard space={space} p={p} addToast={addToast}
                            onOpenSource={p.source === 'story' ? (onOpenStory && p.evidence.storyId ? () => onOpenStory(p.evidence.storyId!) : undefined) : onOpenSyncSource} /></section>
                    ))}
                    {!isPair && onOpenCapsule && dueCapsules.map(e => (
                        <PendingCard key={e.id} icon={Hourglass} title={e.capsule!.cover || (e.capsule!.to === 'both' ? '你們一起封的那兩封' : e.author === 'user' ? `你封給${space.rightName}的那封` : `${space.rightName}封給你的那封`)}
                            quote="不會自己拆開，等你按。" foot="留給以後 · 今天可以打開了" action="打開" onClick={() => onOpenCapsule(e.id)} />
                    ))}
                    {!isPair && onOpenGift && dueGifts.map(e => (
                        <PendingCard key={e.id} icon={Gift} title={e.title || e.text}
                            foot={`打算 ${Number(e.gift!.plannedFor!.slice(5, 7))}/${Number(e.gift!.plannedFor!.slice(8, 10))} 送的，還沒買`} action="去看看" onClick={() => onOpenGift(`e:${e.id}`)}
                            extra={<button type="button" className="text-[12px] text-[var(--bond-muted)] underline underline-offset-2" onClick={() => void saveBondEntry(patchGift(e, { remindedAt: Date.now() }))}>知道了</button>} />
                    ))}
                    {!isPair && onOpenPact && freshCards.length > 0 && (
                        <PendingCard icon={Sparkle} title={`剛解鎖：${freshCards.map(c => c.title).join('、')}`} quote="不急，可以先放著；想演的時候再拿出來。"
                            foot="事件卡" action="去看看" onClick={() => onOpenPact({ tab: 'milestone' })} />
                    )}
                    {notice && onOpenNotice && (
                        <PendingCard icon={EnvelopeSimple} title={notice.label} quote={`「${notice.text}」`}
                            foot={`心意 · ${notice.kind === 'slip' ? '紙條' : notice.kind === 'question' ? '問答' : '日記'}`} action="打開看看" onClick={() => onOpenNotice(notice)} />
                    )}

                    {/* 下一個紀念日 */}
                    <section className="bond-panel px-5 py-4">
                        <PanelLabel icon={CalendarBlank}>下一個紀念日</PanelLabel>
                        {anniversary ? (
                            <div className="bond-serif mt-2.5 text-[17px] font-semibold leading-snug">{anniversary.event.title}</div>
                        ) : (
                            <p className="mt-2.5 text-[13px] text-[var(--bond-muted)]">還沒有記下的紀念日。</p>
                        )}
                        <div className="mt-3 flex items-baseline justify-between gap-3 text-[12.5px]">
                            <span className="text-[var(--bond-ink-2)] min-w-0 truncate">
                                {anniversary ? `${anniversary.date.slice(5).replace('-', '/')} · ${anniversary.daysLeft === 0 ? '就是今天' : `還有 ${anniversary.daysLeft} 天`}` : ''}
                            </span>
                            <button type="button" className="shrink-0 text-[var(--bond-ink-2)]" onClick={onAddAnniversary}>{anniversary ? '到行事曆 ›' : '到行事曆加一個 ›'}</button>
                        </div>
                    </section>

                    {recent && onOpenItem && (
                        <section className="bond-panel px-5 py-4">
                            <button type="button" onClick={() => onOpenItem(recent.key)} className="w-full text-left">
                                <PanelLabel>{recent.favorite ? '最近拾光 · 收藏' : '最近拾光'}</PanelLabel>
                                <div className="bond-serif mt-2.5 text-[17px] font-semibold leading-snug line-clamp-2">{itemHeadline(recent, 60)}</div>
                                <div className="mt-3 flex items-baseline justify-between gap-3 text-[12.5px] text-[var(--bond-ink-2)]">
                                    <span className="min-w-0 truncate">{formatEventDate(recent.eventDate)} · {ITEM_KIND[recent.kind]}</span>
                                    <span className="shrink-0">回到那一天 ›</span>
                                </div>
                            </button>
                        </section>
                    )}

                    {/* 此刻的我們 */}
                    <section className="bond-panel px-5 py-4">
                        <PanelLabel>{isPair ? '此刻的他們' : '此刻的我們'}</PanelLabel>
                        <div className="mt-3 space-y-4">
                            <div>
                                <div className="text-[11.5px] text-[var(--bond-muted)] mb-1">{space.char.name} 寫的</div>
                                {charText
                                    ? <p className="bond-serif text-[14.5px] leading-[1.9] whitespace-pre-wrap">{charText}</p>
                                    : <p className="text-[12.5px] text-[var(--bond-muted)]">還沒寫。</p>}
                                <button type="button" className="mt-2 bond-btn !py-1.5 !text-[12px]" disabled={!!busy} onClick={() => writeOurNow('char')}>
                                    <Sparkle size={13} />{busy === 'char' ? '寫著…' : charText ? '讓 TA 重寫' : '讓 TA 寫'}
                                </button>
                            </div>
                            <div className="border-t bond-hair pt-4">
                                <div className="text-[11.5px] text-[var(--bond-muted)] mb-1">{isPair ? `${space.other!.name} 寫的` : '我眼中的我們'}</div>
                                {otherText
                                    ? <p className="bond-serif text-[14.5px] leading-[1.9] whitespace-pre-wrap">{otherText}</p>
                                    : <p className="text-[12.5px] text-[var(--bond-muted)]">{isPair ? '還沒寫。' : '寫一段你眼中的你們，TA 看得到。'}</p>}
                                {isPair ? (
                                    <button type="button" className="mt-2 bond-btn !py-1.5 !text-[12px]" disabled={!!busy} onClick={() => writeOurNow('other')}>
                                        <Sparkle size={13} />{busy === 'other' ? '寫著…' : otherText ? '讓 TA 重寫' : '讓 TA 寫'}
                                    </button>
                                ) : (
                                    <button type="button" className="mt-2 bond-btn !py-1.5 !text-[12px]" onClick={onEditMine}>
                                        <PencilSimple size={13} />{otherText ? '改一改' : '寫一段'}
                                    </button>
                                )}
                            </div>
                        </div>
                    </section>

                    {/* 親近與信任 */}
                    {!isPair && onOpenFeeling && (
                        <section className="bond-panel px-5 py-4">
                            <button type="button" onClick={onOpenFeeling} className="w-full text-left">
                                <PanelLabel>親近與信任</PanelLabel>
                                <div className="mt-3">
                                    {bond.feeling ? (
                                        <>
                                            <FeelingBars feeling={bond.feeling} route={bond.route} />
                                            {bond.feeling.openHurts.some(h => !h.repairedAt) && (
                                                <div className="mt-2 text-[11.5px] text-[var(--bond-accent)]">還有沒修好的事：{bond.feeling.openHurts.filter(h => !h.repairedAt).map(h => h.what).join('；')}</div>
                                            )}
                                        </>
                                    ) : (
                                        <span className="text-[12.5px] text-[var(--bond-muted)] underline underline-offset-4 decoration-[var(--bond-line)]">{space.rightName}對你的親近和信任——還沒開始記</span>
                                    )}
                                </div>
                            </button>
                        </section>
                    )}

                    {/* 近來：量表、好感；角色 × 角色雙方怎麼看對方 */}
                    {(meters.length > 0 || isPair) && (
                        <section className="bond-panel px-5 py-4">
                            <PanelLabel>{isPair ? '他們怎麼看對方' : '近來'}</PanelLabel>
                            {!isPair && (
                                <div className="mt-1 divide-y bond-hair">
                                    {meters.map(m => (
                                        <div key={m.id} className="py-2.5 flex items-baseline justify-between gap-3">
                                            <div className="text-[13px]">{m.title}</div>
                                            <div className="text-[12px] text-[var(--bond-ink-2)] text-right">{typeof m.value === 'number' ? m.value : ''}{m.statusNote ? ` · ${m.statusNote}` : ''}{!m.statusNote && m.content ? m.content.slice(0, 40) : ''}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {isPair && (
                                <div className="mt-3 space-y-3">
                                    {pairViews.map(v => (
                                        <div key={v.from.id} className="text-[13px] leading-relaxed">
                                            <span className="bond-serif">{v.from.name}</span>
                                            <span className="text-[var(--bond-muted)]"> 眼中的 {v.to.name}：</span>
                                            {v.desc || <span className="text-[var(--bond-muted)]">沒寫</span>}
                                            {typeof contactAffinity(v.from, v.to.id) === 'number' && (
                                                <span className="ml-1.5 text-[11px] text-[var(--bond-muted)]">（好感 {contactAffinity(v.from, v.to.id)}）</span>
                                            )}
                                        </div>
                                    ))}
                                    <label className="flex items-center justify-between gap-3 pt-3 border-t bond-hair">
                                        <span className="text-[12.5px] text-[var(--bond-ink-2)]">他們私下聊了一大段、或存下一章故事時，各自留一篇日記</span>
                                        <input type="checkbox" className="h-4 w-4 accent-[var(--bond-accent)]" checked={bond.pairAutoDiary !== false} onChange={toggleAutoDiary} />
                                    </label>
                                </div>
                            )}
                        </section>
                    )}

                    {/* 近期約定：這期還沒做的、等你說好的，一行一個 */}
                    {upcoming.length > 0 && onOpenPact && (
                        <section className="pt-1 divide-y bond-hair">
                            {upcoming.map(({ e, note }) => (
                                <button key={e.id} type="button" onClick={() => onOpenPact({ tab: 'promise', promiseId: e.id })} className="w-full px-1 py-3 flex items-baseline justify-between gap-3 text-left">
                                    <span className="min-w-0 truncate text-[13.5px] text-[var(--bond-ink-2)]">{note}<span className="mx-1 text-[var(--bond-rose)]">·</span><span className="text-[var(--bond-ink)]">{e.text}</span></span>
                                    <span className="shrink-0 text-[14px] text-[var(--bond-ink-2)]">去看看 ›</span>
                                </button>
                            ))}
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};

const ITEM_KIND: Record<TimelineItem['kind'], string> = { moment: '片刻', memory: '記憶', essay: '隨筆', milestone: '里程碑' };

/** 白卡上的小標：可帶一個圖示 */
const PanelLabel: React.FC<{ icon?: Icon; children: React.ReactNode }> = ({ icon: Ico, children }) => (
    <div className="flex items-center gap-2 text-[13px] text-[var(--bond-ink-2)]">
        {Ico && <Ico size={19} />}
        <span>{children}</span>
    </div>
);

/** 等你接住的一張：淡粉色塊，小標、標題、一句、底下來源與動作 */
const PendingCard: React.FC<{ icon: Icon; title: string; quote?: string; foot: string; action: string; onClick: () => void; extra?: React.ReactNode }> = ({ icon: Ico, title, quote, foot, action, onClick, extra }) => (
    <section className="bond-block bg-[var(--bond-block-blush)] px-5 py-4">
        <button type="button" onClick={onClick} className="w-full text-left">
            <PanelLabel icon={Ico}>等你接住</PanelLabel>
            <div className="bond-serif mt-2.5 text-[17px] font-semibold leading-snug line-clamp-2">{title}</div>
            {quote && <div className="mt-1.5 text-[13.5px] leading-relaxed text-[var(--bond-ink-2)] line-clamp-2">{quote}</div>}
            <div className="mt-3 flex items-baseline justify-between gap-3 text-[12.5px] text-[var(--bond-ink-2)]">
                <span className="min-w-0 truncate">{foot}</span>
                <span className="shrink-0">{action} ›</span>
            </div>
        </button>
        {extra && <div className="mt-2">{extra}</div>}
    </section>
);
