/**
 * 「約定」分頁（plans/bond-batch4.md 第 4 節，紀要 7.2）：願望、共同約定、默契、里程碑。
 * 身份卡 × 角色的空間才有；角色之間的約定在第 6 批。
 * 「想做」跟「已經說好的約定」分開放（紀要 7.4）；說好、確認要雙方都點頭才算。
 */
import React, { useMemo, useState } from 'react';
import { Check, ClockCounterClockwise, Feather, Flag, Handshake, Medal, Sparkle } from '@phosphor-icons/react';
import type { BondEntry } from '../../types';
import { SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import {
    habitWaitingOn, HABIT_STATE_LABEL, milestoneLabel, PROMISE_STATE_LABEL, promiseWaitingOn, repeatLabel, WISH_STATE_LABEL, wishBucket, wishOwnerLabel,
    type WishBucket,
} from '../../utils/bond/pact';
import { eventSortKey, formatEventDate } from '../../utils/bond/eventDate';
import { useBondLedger } from './useBondLedger';
import { LevelPanel } from './BondLevel';
import { EventCardList } from './BondEventCardPages';
import { donePeriod, ledgerKeyOf, promiseStartDay, streakOf, totalPoints } from '../../utils/bond/ledger';
import { dayKeyOf, periodKeyOf, periodWord } from '../../utils/bond/period';
import { memoriesForLine } from '../../utils/bond/timeline';

export type PactTab = 'wish' | 'promise' | 'habit' | 'milestone';

/** 約定分頁有沒有等你回應的（分頁名旁的小點）：TA 提的約定、TA 提的默契、TA 新寫的願望 */
export function pactNeedsYou(entries: BondEntry[]): boolean {
    return entries.some(e =>
        (e.kind === 'promise' && promiseWaitingOn(e) === 'user')
        || (e.kind === 'habit' && habitWaitingOn(e) === 'user')
        || (e.kind === 'wish' && e.author !== 'user' && e.status === 'published' && !e.seenAt)
        || (e.kind === 'eventCard' && e.eventCard?.state === 'unlocked' && !e.seenAt));
}

const Card: React.FC<{ title: string; hint: string; icon: React.ReactNode; onClick: () => void }> = ({ title, hint, icon, onClick }) => (
    <button type="button" onClick={onClick} className="w-full flex items-center justify-between rounded-[18px] bg-[var(--bond-block-mist)] px-4 py-3.5 text-left">
        <span>
            <span className="bond-serif block text-[14px]">{title}</span>
            <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">{hint}</span>
        </span>
        <span className="text-[var(--bond-accent)]">{icon}</span>
    </button>
);

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <p className="py-12 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">{children}</p>
);

export const BondPactPage: React.FC<{
    space: ResolvedSpace;
    tabBar: React.ReactNode;
    header: React.ReactNode;
    pact: PactTab;
    onPact: (t: PactTab) => void;
    onOpenWish: (id: string) => void;
    onNewWish: () => void;
    onOpenPromise: (id: string) => void;
    onNewPromise: () => void;
    onOpenHabit: (id: string) => void;
    onNewHabit: () => void;
    onOpenMilestone: (id: string) => void;
    onNewMilestone: () => void;
    onOpenLedger: () => void;
    onOpenAchievements: () => void;
    onOpenReview: () => void;
    onOpenCard: (key: string) => void;
    onNewCard: () => void;
}> = ({ space, tabBar, header, pact, onPact, onOpenWish, onNewWish, onOpenPromise, onNewPromise, onOpenHabit, onNewHabit, onOpenMilestone, onNewMilestone, onOpenLedger, onOpenAchievements, onOpenReview, onOpenCard, onNewCard }) => {
    const entries = useBondEntries(space.id);
    const ledger = useBondLedger(space.id);
    const points = useMemo(() => totalPoints(ledger), [ledger]);
    const today = dayKeyOf(Date.now());
    // 已經相處一陣子、還沒回顧過：提醒一次（2.6）
    const askReview = !space.bond.pactReview && !points
        && memoriesForLine(space.char.memories, space.personaKey, space.char.primaryPersonaKey).length > 0;
    const name = space.rightName;
    const [wishFilter, setWishFilter] = useState<WishBucket | 'all'>('all');

    const wishes = useMemo(() => entries
        .filter(e => e.kind === 'wish' && e.wish && (e.status === 'published' || e.author === 'user'))
        .sort((a, b) => b.updatedAt - a.updatedAt), [entries]);
    const promises = useMemo(() => entries.filter(e => e.kind === 'promise' && e.promise).sort((a, b) => b.updatedAt - a.updatedAt), [entries]);
    const habits = useMemo(() => entries.filter(e => e.kind === 'habit' && e.habit).sort((a, b) => a.writtenAt - b.writtenAt), [entries]);
    const milestones = useMemo(() => entries.filter(e => e.kind === 'milestone' && e.milestone)
        .sort((a, b) => eventSortKey(b.eventDate).localeCompare(eventSortKey(a.eventDate)) || b.writtenAt - a.writtenAt), [entries]);

    const dots: Record<PactTab, boolean> = {
        wish: wishes.some(e => e.author !== 'user' && !e.seenAt),
        promise: promises.some(e => promiseWaitingOn(e) === 'user'),
        habit: habits.some(e => habitWaitingOn(e) === 'user'),
        milestone: entries.some(e => e.kind === 'eventCard' && e.eventCard?.state === 'unlocked' && !e.seenAt),
    };
    const SUBTABS: Array<{ id: PactTab; label: string }> = [
        { id: 'wish', label: '願望' }, { id: 'promise', label: '約定' }, { id: 'habit', label: '默契' }, { id: 'milestone', label: '里程碑' },
    ];

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            {header}
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-5 pt-4 flex gap-2">
                    {SUBTABS.map(t => (
                        <button key={t.id} type="button" className="bond-chip relative" aria-pressed={pact === t.id} onClick={() => onPact(t.id)}>
                            {t.label}
                            {dots[t.id] && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--bond-accent)]" aria-label="等你回應" />}
                        </button>
                    ))}
                </div>

                {askReview && (
                    <div className="px-5 pt-4">
                        <button type="button" onClick={onOpenReview} className="w-full text-left bond-block bg-[var(--bond-block-blush)] px-4 py-3">
                            <span className="bond-serif block text-[14px]">你們已經相處一陣子了</span>
                            <span className="block mt-0.5 text-[11.5px] text-[var(--bond-ink-2)]">回顧一下發生過的大事、補算過去的相處，或從現在開始算。</span>
                        </button>
                    </div>
                )}

                {pact === 'wish' && (
                    <div className="px-5 pt-4 pb-12">
                        <Card title="寫一個願望" hint={`我的，或我們想一起完成的；發布了${name}才看得到`} icon={<Feather size={16} />} onClick={onNewWish} />
                        <div className="mt-4 flex gap-2">
                            {(['all', 'mine', 'theirs', 'ours'] as const).map(f => (
                                <button key={f} type="button" className="bond-chip" aria-pressed={wishFilter === f} onClick={() => setWishFilter(f)}>
                                    {f === 'all' ? '全部' : f === 'mine' ? '我的' : f === 'theirs' ? `${name}的` : '我們的'}
                                </button>
                            ))}
                        </div>
                        {(() => {
                            const list = wishes.filter(w => wishFilter === 'all' || wishBucket(w) === wishFilter);
                            if (!list.length) return <Empty>還沒有願望。看見願望不等於答應；談好了才變成約定。</Empty>;
                            return (
                                <div className="mt-4 bond-panel px-4 divide-y bond-hair">
                                    {list.map(w => (
                                        <button key={w.id} type="button" onClick={() => onOpenWish(w.id)} className="w-full text-left py-3.5">
                                            <div className="flex items-center gap-2 text-[10.5px] tracking-wider text-[var(--bond-muted)]">
                                                <span>{wishOwnerLabel(w.wish!.owner, name)}</span>
                                                <span>· {WISH_STATE_LABEL[w.wish!.state]}</span>
                                                {w.status === 'draft' && <span>· 草稿</span>}
                                                {w.wish!.support && <span>· {w.wish!.support.by === 'user' ? '你' : name}支持</span>}
                                                {w.author !== 'user' && !w.seenAt && <span className="text-[var(--bond-accent)]">· 新</span>}
                                            </div>
                                            <div className={`bond-serif mt-1 text-[14px] leading-relaxed ${w.wish!.state === 'shelved' ? 'text-[var(--bond-muted)]' : ''}`}>{w.text.replace(/\s+/g, ' ').slice(0, 80)}</div>
                                        </button>
                                    ))}
                                </div>
                            );
                        })()}
                    </div>
                )}

                {pact === 'promise' && (
                    <div className="px-5 pt-4 pb-12">
                        <Card title="新增約定" hint="自己寫，或從模板挑；要雙方都說好才成立" icon={<Handshake size={16} />} onClick={onNewPromise} />
                        {promises.length === 0 ? (
                            <Empty>還沒有約定。每天晚安、每週通一次電話、一起去看海……說好了就是你們的約定。</Empty>
                        ) : (
                            ([
                                { key: 'active', label: '進 行 中', match: (e: BondEntry) => e.promise!.state === 'active' },
                                { key: 'proposed', label: '還 在 商 量', match: (e: BondEntry) => e.promise!.state === 'proposed' },
                                { key: 'other', label: '暫 停 ・ 完 成 ・ 不 做 了', match: (e: BondEntry) => ['paused', 'done', 'dropped'].includes(e.promise!.state) },
                            ]).map(sec => {
                                const list = promises.filter(sec.match);
                                if (!list.length) return null;
                                return (
                                    <section key={sec.key} className="mt-6">
                                        <SectionLabel>{sec.label}</SectionLabel>
                                        <div className="bond-panel px-4 divide-y bond-hair">
                                            {list.map(p => {
                                                const waiting = promiseWaitingOn(p);
                                                const pr = p.promise!;
                                                const start = promiseStartDay(p) || undefined;
                                                const live = pr.state === 'active' && pr.repeat.kind !== 'once';
                                                const doneNow = live && !!donePeriod(ledger, ledgerKeyOf(p), periodKeyOf(pr.repeat, today, start));
                                                const streak = live ? streakOf(ledger, ledgerKeyOf(p), pr.repeat, today, start).current : 0;
                                                return (
                                                    <button key={p.id} type="button" onClick={() => onOpenPromise(p.id)} className="w-full text-left py-3.5 flex gap-3">
                                                        {live && (
                                                            <span className={`mt-1 h-5 w-5 shrink-0 rounded-full border grid place-items-center ${doneNow ? 'bg-[var(--bond-accent)] border-[var(--bond-accent)] text-[var(--bond-on-accent)]' : 'bond-hair'}`}
                                                                aria-label={doneNow ? `${periodWord(pr.repeat)}做到了` : `${periodWord(pr.repeat)}還沒`}>
                                                                {doneNow && <Check size={12} weight="bold" />}
                                                            </span>
                                                        )}
                                                        <span className="min-w-0 flex-1">
                                                        <div className="bond-serif text-[14px] leading-relaxed">{p.text}</div>
                                                        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10.5px] tracking-wider text-[var(--bond-muted)]">
                                                            <span>{repeatLabel(p.promise!.repeat)}</span>
                                                            {p.promise!.points ? <span>· {p.promise!.points} 分</span> : null}
                                                            {waiting && <span className={waiting === 'user' ? 'text-[var(--bond-accent)]' : ''}>· {waiting === 'user' ? '等你說好' : `等${name}說好`}</span>}
                                                            {!waiting && p.promise!.state !== 'active' && <span>· {PROMISE_STATE_LABEL[p.promise!.state]}</span>}
                                                            {streak >= 2 && <span className="text-[var(--bond-accent)]">· 連續 {streak}{pr.repeat.kind === 'daily' ? ' 天' : ' 期'}</span>}
                                                        </div>
                                                        </span>
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </section>
                                );
                            })
                        )}
                    </div>
                )}

                {pact === 'habit' && (
                    <div className="px-5 pt-4 pb-12">
                        <Card title="寫一條默契" hint={`你們說好、或已經反覆這樣的小習慣；${name}認了才算`} icon={<Sparkle size={16} />} onClick={onNewHabit} />
                        {habits.length === 0 ? (
                            <Empty>一起聽歌時輪流選第一首、先到家的人傳一張窗外照片、只有你們懂的爛梗……這些是你們的默契。</Empty>
                        ) : (
                            ([
                                { key: 'active', label: '我 們 的 默 契', match: (e: BondEntry) => e.habit!.state === 'active' },
                                { key: 'proposed', label: '等 確 認', match: (e: BondEntry) => e.habit!.state === 'proposed' },
                                { key: 'retired', label: '不 再 這 樣 了', match: (e: BondEntry) => e.habit!.state === 'retired' },
                            ]).map(sec => {
                                const list = habits.filter(sec.match);
                                if (!list.length) return null;
                                return (
                                    <section key={sec.key} className="mt-6">
                                        <SectionLabel>{sec.label}</SectionLabel>
                                        <div className="space-y-2">
                                            {list.map(h => {
                                                const waiting = habitWaitingOn(h);
                                                return (
                                                    <button key={h.id} type="button" onClick={() => onOpenHabit(h.id)}
                                                        className={`w-full text-left rounded-xl border bond-hair px-4 py-3 ${h.habit!.state === 'active' ? 'bg-[var(--bond-card)]' : 'bg-transparent'}`}>
                                                        <div className={`bond-serif text-[14px] leading-relaxed ${h.habit!.state === 'active' ? '' : 'text-[var(--bond-ink-2)]'}`}>{h.text}</div>
                                                        {waiting && <div className={`mt-1 text-[10.5px] ${waiting === 'user' ? 'text-[var(--bond-accent)]' : 'text-[var(--bond-muted)]'}`}>{waiting === 'user' ? `${name}提的，等你確認` : `等${name}確認`}</div>}
                                                        {!waiting && h.habit!.state !== 'active' && <div className="mt-1 text-[10.5px] text-[var(--bond-muted)]">{HABIT_STATE_LABEL[h.habit!.state]}</div>}
                                                    </button>
                                                );
                                            })}
                                        </div>
                                    </section>
                                );
                            })
                        )}
                    </div>
                )}

                {pact === 'milestone' && (
                    <div className="px-5 pt-4 pb-12">
                        <LevelPanel points={points}>
                            <button type="button" className="bond-btn" onClick={onOpenLedger}><ClockCounterClockwise size={14} />完成紀錄</button>
                            <button type="button" className="bond-btn" onClick={onOpenAchievements}><Medal size={14} />成就</button>
                            <button type="button" className="bond-btn" onClick={onOpenReview}>回顧與補算</button>
                        </LevelPanel>
                        <EventCardList space={space} onOpen={onOpenCard} onNewCustom={onNewCard} />
                        <div className="mt-6" />
                        <Card title="記一個里程碑" hint="已經發生的大事：告白、在一起、成為摯友、和好……" icon={<Flag size={16} />} onClick={onNewMilestone} />
                        {milestones.length === 0 ? (
                            <Empty>還沒有里程碑。</Empty>
                        ) : (
                            <div className="mt-5 bond-panel px-4 divide-y bond-hair">
                                {milestones.map(m => (
                                    <button key={m.id} type="button" onClick={() => onOpenMilestone(m.id)} className="w-full text-left py-3.5 flex gap-4">
                                        <div className="w-24 shrink-0 pt-0.5 text-[11px] text-[var(--bond-muted)] leading-snug whitespace-nowrap">{formatEventDate(m.eventDate)}</div>
                                        <div className="min-w-0 flex-1">
                                            <div className="bond-serif text-[14px] leading-relaxed">{m.title || milestoneLabel(m.milestone!.what)}</div>
                                            {m.text && <div className="mt-0.5 text-[12px] text-[var(--bond-ink-2)] leading-relaxed">{m.text.slice(0, 80)}</div>}
                                        </div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};
