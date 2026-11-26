/**
 * 一段關係的首頁「我們」（plans/bond-batch1.md 3.3）：關係主視覺、建議路線卡、此刻的我們、下一個紀念日、
 * 天數；角色 × 角色多一塊「他們怎麼看對方」和私聊整理時自動留日記的開關。
 */
import React, { useMemo, useState } from 'react';
import { CaretRight, PencilSimple, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, CalendarEvent, CharacterProfile } from '../../types';
import { AvatarPair, BondHeader, SectionLabel } from './bondUi';
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
import { pickRecentItem } from '../../utils/bond/timeline';
import { formatEventDate } from '../../utils/bond/eventDate';
import { useBondLedger } from './useBondLedger';
import { useBondEntries } from './useSpaceTimeline';
import { LevelMark } from './BondLevel';
import { donePeriod, ledgerKeyOf, promiseStartDay, totalPoints } from '../../utils/bond/ledger';
import { countsOnDay, dayKeyOf, periodKeyOf, periodWord } from '../../utils/bond/period';
import { promiseWaitingOn } from '../../utils/bond/pact';

const formatDay = (key: string) => {
    const [y, m, d] = key.split('-');
    return y && m && d ? `${y} 年 ${Number(m)} 月 ${Number(d)} 日` : key;
};

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
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, characters, events, apiConfig, onBack, onOpenRoute, onOpenDays, onEditMine, onAddAnniversary, tabBar, onOpenItem, onOpenNotice, onOpenPact, addToast }) => {
    const notice = useHeartNotice(space);
    const ledger = useBondLedger(space.id);
    const pactEntries = useBondEntries(space.id);
    const points = useMemo(() => totalPoints(ledger), [ledger]);
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

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={isPair ? `${space.leftName} & ${space.rightName}` : space.rightName} onBack={onBack}
                right={<button type="button" onClick={onOpenRoute} className="bond-note px-2 py-1">路線</button>} />
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                {/* 關係主視覺 */}
                <section className="px-6 pt-8 pb-7 text-center border-b bond-hair">
                    <div className="flex justify-center"><AvatarPair a={space.leftAvatar} b={space.rightAvatar} aName={space.leftName} bName={space.rightName} size={64} /></div>
                    <div className="bond-serif mt-4 text-[19px] tracking-wide">{space.leftName}<span className="mx-2 text-[var(--bond-rose)]">&amp;</span>{space.rightName}</div>
                    <div className="mt-1 text-[11px] text-[var(--bond-muted)]">{formatDay(space.todayKey)}</div>
                    <button type="button" onClick={onOpenDays} className="mt-5 block mx-auto">
                        {counter.days !== null ? (
                            // 天數做成頁邊小註記的分量（bond-batch1 3.3「不做大徽章」）
                            <div className="text-[12px] text-[var(--bond-ink-2)] tracking-wide">
                                {counter.label}的第<span className="bond-serif mx-1 text-[17px] text-[var(--bond-ink)] tabular-nums">{counter.days}</span>天
                            </div>
                        ) : (
                            <div className="text-[12px] text-[var(--bond-muted)] underline underline-offset-4 decoration-[var(--bond-line)]">填一個起點，開始算天數</div>
                        )}
                    </button>
                    {!isPair && onOpenPact && (points > 0 || pactEntries.some(e => e.kind === 'promise')) && (
                        <div className="mt-2"><LevelMark points={points} onClick={() => onOpenPact({ tab: 'milestone' })} /></div>
                    )}
                    <button type="button" onClick={onOpenRoute} className="mt-5 inline-flex items-center gap-1.5 text-[12.5px] text-[var(--bond-ink-2)]">
                        <span className="bond-serif">{routeLabel(bond.route)}</span>
                        <span className="text-[var(--bond-rose)]">·</span>
                        <span>{stageLabel(bond)}</span>
                        <CaretRight size={11} className="text-[var(--bond-muted)]" />
                    </button>
                </section>

                <div className="px-5 pt-6 space-y-8" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 40px)' }}>
                    {suggestion && (
                        <section className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3.5">
                            <div className="text-[13px] leading-relaxed">
                                看起來{isPair ? '他們' : '你們'}是<span className="bond-serif text-[var(--bond-accent)]">{suggestion.label || stageLabel({ route: suggestion.route, stage: suggestion.stage })}</span>
                                <span className="text-[var(--bond-muted)]">（「{suggestion.from}」）</span>，要設成{ROUTE_LABEL[suggestion.route]}線嗎？
                            </div>
                            <div className="mt-3 flex gap-2">
                                <button type="button" className="bond-btn bond-btn-primary" onClick={acceptSuggestion}>設定</button>
                                <button type="button" className="bond-btn" onClick={dismissSuggestion}>不是</button>
                            </div>
                        </section>
                    )}

                    {/* 此刻的我們 */}
                    <section>
                        <SectionLabel>{isPair ? '此 刻 的 他 們' : '此 刻 的 我 們'}</SectionLabel>
                        <div className="space-y-4">
                            <div>
                                <div className="text-[11px] text-[var(--bond-muted)] mb-1">{space.char.name} 寫的</div>
                                {charText
                                    ? <p className="bond-serif text-[14.5px] leading-[1.9] whitespace-pre-wrap">{charText}</p>
                                    : <p className="text-[12.5px] text-[var(--bond-muted)]">還沒寫。</p>}
                                <button type="button" className="mt-2 bond-btn !py-1.5 !text-[12px]" disabled={!!busy} onClick={() => writeOurNow('char')}>
                                    <Sparkle size={13} />{busy === 'char' ? '寫著…' : charText ? '讓 TA 重寫' : '讓 TA 寫'}
                                </button>
                            </div>
                            <div className="border-t bond-hair pt-4">
                                <div className="text-[11px] text-[var(--bond-muted)] mb-1">{isPair ? `${space.other!.name} 寫的` : '我眼中的我們'}</div>
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

                    {notice && onOpenNotice && (
                        <section>
                            <SectionLabel>最 近 值 得 留 意</SectionLabel>
                            <button type="button" onClick={() => onOpenNotice(notice)} className="w-full text-left rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
                                <div className="text-[11px] text-[var(--bond-accent)]">{notice.label}</div>
                                <div className="bond-serif mt-1 text-[14.5px] leading-relaxed line-clamp-2">{notice.text}</div>
                            </button>
                        </section>
                    )}

                    {upcoming.length > 0 && onOpenPact && (
                        <section>
                            <SectionLabel>近 期 約 定</SectionLabel>
                            <div className="divide-y bond-hair border-y">
                                {upcoming.map(({ e, note }) => (
                                    <button key={e.id} type="button" onClick={() => onOpenPact({ tab: 'promise', promiseId: e.id })} className="w-full py-2.5 flex items-baseline justify-between gap-3 text-left">
                                        <span className="bond-serif text-[14px] min-w-0 truncate">{e.text}</span>
                                        <span className="text-[11px] text-[var(--bond-muted)] shrink-0">{note}</span>
                                    </button>
                                ))}
                            </div>
                        </section>
                    )}

                    {/* 下一個紀念日 */}
                    <section>
                        <SectionLabel>下 一 個 紀 念 日</SectionLabel>
                        {anniversary ? (
                            <div className="flex items-baseline justify-between gap-3">
                                <div className="bond-serif text-[15px] min-w-0 truncate">{anniversary.event.title}</div>
                                <div className="text-[12px] text-[var(--bond-ink-2)] shrink-0">{anniversary.date.slice(5).replace('-', '/')} · {anniversary.daysLeft === 0 ? '就是今天' : `還有 ${anniversary.daysLeft} 天`}</div>
                            </div>
                        ) : (
                            <p className="text-[12.5px] text-[var(--bond-muted)]">還沒有記下的紀念日。</p>
                        )}
                        <button type="button" className="mt-2 text-[12px] text-[var(--bond-accent)]" onClick={onAddAnniversary}>到行事曆加一個 ›</button>
                    </section>

                    {recent && onOpenItem && (
                        <section>
                            <SectionLabel>最 近 拾 光</SectionLabel>
                            <button type="button" onClick={() => onOpenItem(recent.key)} className="w-full text-left">
                                <div className="text-[11px] text-[var(--bond-muted)]">{formatEventDate(recent.eventDate)}{recent.favorite ? ' · 收藏' : ''}</div>
                                <div className="bond-serif mt-1 text-[14.5px] leading-relaxed">{itemHeadline(recent, 90)}</div>
                            </button>
                        </section>
                    )}

                    {/* 關係概覽：親近與信任（讀現成的量表／好感），角色 × 角色雙方怎麼看對方 */}
                    {(meters.length > 0 || isPair) && (
                        <section>
                            <SectionLabel>{isPair ? '他 們 怎 麼 看 對 方' : '近 來'}</SectionLabel>
                            {!isPair && (
                                <div className="divide-y bond-hair">
                                    {meters.map(m => (
                                        <div key={m.id} className="py-2.5 flex items-baseline justify-between gap-3">
                                            <div className="text-[13px]">{m.title}</div>
                                            <div className="text-[12px] text-[var(--bond-ink-2)] text-right">{typeof m.value === 'number' ? m.value : ''}{m.statusNote ? ` · ${m.statusNote}` : ''}{!m.statusNote && m.content ? m.content.slice(0, 40) : ''}</div>
                                        </div>
                                    ))}
                                </div>
                            )}
                            {isPair && (
                                <div className="space-y-3">
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
                                        <span className="text-[12.5px] text-[var(--bond-ink-2)]">他們私下聊了一大段之後，各自留一篇日記</span>
                                        <input type="checkbox" className="h-4 w-4 accent-[var(--bond-accent)]" checked={bond.pairAutoDiary !== false} onChange={toggleAutoDiary} />
                                    </label>
                                </div>
                            )}
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};
