/**
 * 約定第 4b 批的全螢幕頁（plans/bond-batch4.md 4.2、1.2b、2.6）：
 * - 完成紀錄：全部約定的紀錄與成就，照時間排，能篩、能撤銷／恢復；
 * - 成就：達成的、還沒的；
 * - 回顧與補算：讓 AI 讀每日總結找出大事（一個個確認才記成里程碑）、照模板的預設分數補算過去的相處、或從現在開始。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowCounterClockwise, Check, Medal, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondLedgerRow } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondLedger } from './useBondLedger';
import { LevelPanel } from './BondLevel';
import { allAchievementSlots, isCounted, totalPoints } from '../../utils/bond/ledger';
import { setLedgerRevoked } from '../../utils/bond/ledgerStore';
import { milestoneKindsFor, milestoneLabel, newMilestone, PROMISE_TEMPLATES, templateTitle } from '../../utils/bond/pact';
import { saveBondEntries } from '../../utils/bond/entries';
import { updateBond } from '../../utils/bond/store';
import { dayEventDate } from '../../utils/bond/eventDate';
import { memoriesForLine } from '../../utils/bond/timeline';
import { buildMilestoneReviewPrompt, parseMilestoneReview, type ReviewCandidate } from '../../utils/bond/pactPrompt';
import { dayKeyOf } from '../../utils/bond/period';
import { globalMeterApi } from '../../utils/apiCenter';
import { extractContent, safeFetchJson } from '../../utils/safeApi';
import { DB } from '../../utils/db';
import { charParticipant, newEvent, personaParticipant } from '../../utils/calendarEvents';
import { loadLineDays, previewBackfill, runBackfill, type BackfillPreview } from './pactRun';
import { trackEvent } from '../../utils/analytics';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const HOW_LABEL: Record<BondLedgerRow['how'], string> = { auto: '照紀錄', manual: '你記的', ai: 'AI 判讀', backfill: '補算' };

const whenOf = (r: BondLedgerRow): string => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.periodKey)) return r.periodKey;
    if (/^\d{4}-W\d{2}$/.test(r.periodKey)) return `${r.periodKey.replace('-W', ' 第 ')} 週`;
    if (/^\d{4}-\d{2}$/.test(r.periodKey)) return `${r.periodKey.replace('-', ' 年 ')} 月`;
    return dayKeyOf(r.at);
};

/** 一筆紀錄（約定或成就）：可以撤銷／恢復 */
export const LedgerRowItem: React.FC<{ row: BondLedgerRow; showLabel?: boolean }> = ({ row, showLabel = true }) => {
    const revoked = !!row.revokedAt;
    const ach = row.key.startsWith('ach:');
    return (
        <div className={`py-3 flex items-start gap-3 ${revoked || row.miss ? 'opacity-60' : ''}`}>
            <span className="mt-0.5 w-20 shrink-0 text-[11px] text-[var(--bond-muted)] leading-snug">{whenOf(row)}</span>
            <span className="min-w-0 flex-1">
                {showLabel && <span className="bond-serif block text-[13.5px] leading-relaxed">{ach && <Medal size={12} className="inline mr-1 -mt-0.5 text-[var(--bond-accent)]" />}{row.label}</span>}
                <span className="block text-[10.5px] text-[var(--bond-muted)]">
                    {row.miss ? 'AI 判讀：沒做到' : `${HOW_LABEL[row.how]} · ＋${row.points}`}
                    {row.evidence?.messageIds?.length ? ` · 依據 ${row.evidence.messageIds.length} 則訊息` : ''}
                    {revoked ? ' · 撤銷了' : ''}
                </span>
                {row.evidence?.reason && <span className="block mt-0.5 text-[11px] text-[var(--bond-ink-2)]">{row.evidence.reason}</span>}
            </span>
            {!row.miss && (
                <button type="button" className="shrink-0 text-[11px] text-[var(--bond-accent)] py-0.5"
                    onClick={async () => {
                        await setLedgerRevoked(row.id, !revoked);
                        if (!revoked) trackEvent('撤销约定完成', {});
                    }}>
                    {revoked ? '恢復' : '撤銷'}
                </button>
            )}
        </div>
    );
};

export const BondLedgerPage: React.FC<{ space: ResolvedSpace; onBack: () => void }> = ({ space, onBack }) => {
    const ledger = useBondLedger(space.id);
    const [filter, setFilter] = useState<'all' | 'promise' | 'ach' | 'backfill'>('all');
    const rows = useMemo(() => ledger
        .filter(r => !r.key.startsWith('fact:') && (r.points || r.miss))
        .filter(r => filter === 'all' || (filter === 'ach' ? r.key.startsWith('ach:') : filter === 'backfill' ? r.how === 'backfill' : !r.key.startsWith('ach:')))
        .sort((a, b) => whenOf(b).localeCompare(whenOf(a)) || b.at - a.at), [ledger, filter]);
    const [shown, setShown] = useState(60);
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="完成紀錄" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5">
                <LevelPanel points={totalPoints(ledger)} />
                <div className="mt-4 flex flex-wrap gap-2">
                    {([['all', '全部'], ['promise', '約定'], ['ach', '成就'], ['backfill', '補算']] as const).map(([id, label]) => (
                        <button key={id} type="button" className="bond-chip" aria-pressed={filter === id} onClick={() => setFilter(id)}>{label}</button>
                    ))}
                </div>
                {rows.length === 0 ? (
                    <p className="py-12 text-center text-[12.5px] text-[var(--bond-muted)]">還沒有紀錄。約定做到了、達成成就，就會記在這裡。</p>
                ) : (
                    <div className="mt-3 divide-y bond-hair border-y">
                        {rows.slice(0, shown).map(r => <LedgerRowItem key={r.id} row={r} />)}
                    </div>
                )}
                {rows.length > shown && <button type="button" className="bond-btn mt-4 w-full justify-center" onClick={() => setShown(n => n + 60)}>再看 60 筆</button>}
                <p className="mt-4 text-[11px] leading-relaxed text-[var(--bond-muted)]">撤銷的留著看得到，不算分，可以恢復。同一個約定同一期只會記一筆，自動判到、你又手動記，也只算一次。</p>
            </div>
        </div>
    );
};

export const BondAchievementsPage: React.FC<{ space: ResolvedSpace; onBack: () => void }> = ({ space, onBack }) => {
    const ledger = useBondLedger(space.id);
    const got = useMemo(() => ledger.filter(r => r.key.startsWith('ach:')), [ledger]);
    const slots = allAchievementSlots();
    const trips = got.filter(r => r.key === 'ach:trip');
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="成就" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">照你們實際的紀錄，達成一次加一次分；不用約好、不用說好。等級本身不會再加分。</p>
                <div className="mt-4 divide-y bond-hair border-y">
                    {slots.map(s => {
                        const row = s.periodKey === '*' ? null : got.find(r => r.key === s.key && r.periodKey === s.periodKey);
                        const done = s.periodKey === '*' ? trips.length > 0 : !!row && isCounted(row);
                        return (
                            <div key={`${s.key}|${s.periodKey}`} className={`py-3 flex items-center gap-3 ${done ? '' : 'opacity-55'}`}>
                                <span className={`h-7 w-7 shrink-0 rounded-full grid place-items-center ${done ? 'bg-[var(--bond-accent)] text-[var(--bond-on-accent)]' : 'border bond-hair text-[var(--bond-muted)]'}`}><Medal size={14} /></span>
                                <span className="min-w-0 flex-1">
                                    <span className="bond-serif block text-[13.5px]">{row?.label || s.label}{s.periodKey === '*' && trips.length ? `（${trips.length} 趟）` : ''}</span>
                                    <span className="block text-[10.5px] text-[var(--bond-muted)]">＋{s.points}{row ? ` · ${dayKeyOf(row.at)}${row.how === 'backfill' ? ' · 補算' : ''}${row.revokedAt ? ' · 撤銷了' : ''}` : ''}</span>
                                </span>
                            </div>
                        );
                    })}
                </div>
                <p className="mt-4 text-[11px] leading-relaxed text-[var(--bond-muted)]">一起旅行要在行事曆的旅行裡把同行的人選上這位。</p>
            </div>
        </div>
    );
};

// ─── 回顧與補算（2.6）──────────────────────────────

interface ReviewPick extends ReviewCandidate { on: boolean; anniversary: boolean }

export const BondReviewPage: React.FC<{ space: ResolvedSpace; apiConfig: APIConfig; onBack: () => void; onOpenRoute: () => void; addToast: Toast }> = ({ space, apiConfig, onBack, onOpenRoute, addToast }) => {
    const name = space.rightName;
    const kinds = milestoneKindsFor(space.bond.route).filter(k => k.id !== 'custom');
    const summaries = useMemo(() => memoriesForLine(space.char.memories, space.personaKey, space.char.primaryPersonaKey)
        .filter(m => (m.summary || '').trim())
        .sort((a, b) => a.date.localeCompare(b.date))
        .map(m => ({ id: m.id, date: m.date, text: m.summary.replace(/\s+/g, ' ').slice(0, 400) })), [space]);
    const [reviewing, setReviewing] = useState(false);
    const [picks, setPicks] = useState<ReviewPick[] | null>(null);
    const [days, setDays] = useState<Awaited<ReturnType<typeof loadLineDays>> | null>(null);
    const [preview, setPreview] = useState<BackfillPreview | null>(null);
    const [tpls, setTpls] = useState<string[]>(PROMISE_TEMPLATES.map(t => t.id));
    const [filling, setFilling] = useState(false);

    const ledger = useBondLedger(space.id);
    useEffect(() => {
        let alive = true;
        void loadLineDays(space).then(d => { if (alive) setDays(d); });
        return () => { alive = false; };
    }, [space]);
    // 已經記過的那天（自動判到的、補算過的）不再算進「會補多少」
    useEffect(() => {
        if (!days) return;
        const ids = new Set(ledger.map(r => r.id));
        setPreview(previewBackfill(days, dayKeyOf(Date.now()), (key, day) => ids.has(`${space.id}|${key}|${day}`)));
    }, [days, ledger, space.id]);

    const review = async () => {
        const api = globalMeterApi(apiConfig) || (apiConfig.baseUrl && apiConfig.apiKey ? { baseUrl: apiConfig.baseUrl, apiKey: apiConfig.apiKey, model: apiConfig.model } : null);
        if (!api) { addToast('還沒設定 API', 'error'); return; }
        setReviewing(true);
        try {
            // 總結太多時只讀最近的（模型讀不完）
            const recent = summaries.slice(-180);
            const data = await safeFetchJson(`${api.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${api.apiKey}` },
                body: JSON.stringify({
                    model: api.model,
                    messages: [{ role: 'user', content: buildMilestoneReviewPrompt({ leftName: space.leftName, rightName: name, kinds, summaries: recent }) }],
                    temperature: 0.3,
                    max_tokens: 2500,
                }),
            }, 1, 120_000, { appName: '羈絆', charId: space.char.id, charName: space.char.name, purpose: '回顧里程碑' });
            const found = parseMilestoneReview(extractContent(data), recent, kinds.map(k => k.id));
            setPicks(found.map(c => ({ ...c, on: true, anniversary: false })));
            if (!found.length) addToast('總結裡沒看到關係的轉折', 'info');
        } catch (e: any) {
            addToast(e?.message || '這次沒讀成，再試一次', 'error');
        } finally {
            setReviewing(false);
        }
    };

    const saveMilestones = async () => {
        if (!picks) return;
        const chosen = picks.filter(p => p.on);
        const entries = [];
        for (const p of chosen) {
            let e = newMilestone({
                bondId: space.id, author: 'user', what: p.what, title: p.title, text: p.text,
                eventDate: p.date ? dayEventDate(p.date) : { precision: 'unknown' }, via: 'review',
                sources: p.memoryIds.map(id => ({ type: 'memory' as const, charId: space.char.id, memoryId: id })),
            });
            if (p.anniversary && p.date) {
                const ev = newEvent({
                    owner: personaParticipant(space.personaKey), kind: 'anniversary', title: `${milestoneLabel(p.what, p.title)}紀念日`, start: p.date, allDay: true,
                    participants: [charParticipant(space.char.id)], repeat: 'yearly', charRemembers: true, source: 'user',
                });
                await DB.saveCalendarEvent(ev);
                e = { ...e, milestone: { ...e.milestone!, anniversaryId: ev.id } };
            }
            entries.push(e);
        }
        await saveBondEntries(entries);
        await updateBond(space.id, b => ({ ...b, pactReview: { ...(b.pactReview || {}), reviewedAt: Date.now() } }));
        for (const _ of chosen) trackEvent('同步承认关系', { 结果: '对', 来源: '回顾' });
        addToast(chosen.length ? `記下 ${chosen.length} 個里程碑` : '好，一個都不記', 'success');
        setPicks(null);
    };

    const backfill = async () => {
        if (!days) return;
        setFilling(true);
        try {
            const out = await runBackfill(space, days, tpls);
            addToast(out.points ? `補算了 ＋${out.points}` : '補算完了（沒有新的分數）', 'success');
        } catch (e: any) {
            addToast(`補算沒成功：${e?.message || e}`, 'error');
        } finally {
            setFilling(false);
        }
    };

    const skip = async () => {
        await updateBond(space.id, b => ({ ...b, pactReview: { ...(b.pactReview || {}), skippedAt: Date.now() } }));
        addToast('好，從現在開始算', 'success');
        onBack();
    };

    const reviewed = space.bond.pactReview;
    const fillPoints = preview ? preview.byTemplate.filter(t => tpls.includes(t.id)).reduce((s, t) => s + t.points, 0) : 0;

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="回顧與補算" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-8">
                <section>
                    <SectionLabel>一 、 現 在 是 什 麼 關 係</SectionLabel>
                    <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">已經是戀人、摯友、家人的，直接在路線頁照實際選；等級跟階段分開，不會因為等級不夠擋住。</p>
                    <button type="button" className="bond-btn mt-3" onClick={onOpenRoute}>去路線頁</button>
                </section>

                <section>
                    <SectionLabel>二 、 回 顧 發 生 過 的 大 事</SectionLabel>
                    <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">讓 AI 讀這條線的每日總結（{summaries.length} 天），找出告白、在一起、和好、成為摯友這類轉折；你一個個確認才記成里程碑。</p>
                    {!picks ? (
                        <button type="button" className="bond-btn mt-3" disabled={reviewing || !summaries.length} onClick={review}><Sparkle size={14} />{reviewing ? '讀總結中…' : summaries.length ? '開始回顧' : '還沒有每日總結'}</button>
                    ) : (
                        <div className="mt-3 space-y-3">
                            {picks.length === 0 && <p className="text-[12px] text-[var(--bond-muted)]">沒有找到。</p>}
                            {picks.map((p, i) => (
                                <div key={i} className={`rounded-xl border bond-hair px-4 py-3 ${p.on ? 'bg-[var(--bond-card)]' : 'opacity-60'}`}>
                                    <div className="flex items-center justify-between gap-2">
                                        <span className="bond-serif text-[14px]">{milestoneLabel(p.what, p.title)}</span>
                                        <button type="button" className="bond-chip" aria-pressed={p.on} onClick={() => setPicks(ps => ps!.map((x, j) => (j === i ? { ...x, on: !x.on } : x)))}>{p.on ? '記下來' : '不是'}</button>
                                    </div>
                                    <div className="mt-1 text-[12px] leading-relaxed text-[var(--bond-ink-2)]">{p.text}</div>
                                    <div className="mt-2 flex flex-wrap items-center gap-2">
                                        <input type="date" className="bond-input" style={{ width: 160, flex: 'none' }} value={p.date || ''}
                                            onChange={e => setPicks(ps => ps!.map((x, j) => (j === i ? { ...x, date: e.target.value || undefined } : x)))} />
                                        {p.date && <button type="button" className="bond-chip" aria-pressed={p.anniversary} onClick={() => setPicks(ps => ps!.map((x, j) => (j === i ? { ...x, anniversary: !x.anniversary } : x)))}>記成紀念日</button>}
                                    </div>
                                </div>
                            ))}
                            <div className="flex gap-2">
                                <button type="button" className="bond-btn" onClick={() => setPicks(null)}>先不要</button>
                                <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={saveMilestones}><Check size={14} />記下勾的（{picks.filter(p => p.on).length}）</button>
                            </div>
                        </div>
                    )}
                    {reviewed?.reviewedAt && !picks && <p className="mt-2 text-[11px] text-[var(--bond-muted)]">{dayKeyOf(reviewed.reviewedAt)} 回顧過，可以再跑一次。</p>}
                </section>

                <section>
                    <SectionLabel>三 、 補 算 過 去 的 相 處</SectionLabel>
                    {!preview ? (
                        <p className="text-[12px] text-[var(--bond-muted)]">讀聊天紀錄中…</p>
                    ) : (
                        <>
                            <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                                照任務模板的預設分數，把今天以前的紀錄（{preview.firstDay ? `${preview.firstDay} 起，` : ''}{preview.days} 天有聊天）和成就一次補進來，標「補算」，之後一樣可以撤銷。勾你想算的：
                            </p>
                            <div className="mt-3 divide-y bond-hair border-y">
                                {PROMISE_TEMPLATES.map(t => {
                                    const st = preview.byTemplate.find(x => x.id === t.id)!;
                                    const on = tpls.includes(t.id);
                                    return (
                                        <button key={t.id} type="button" className="w-full py-2.5 flex items-center gap-3 text-left" aria-pressed={on}
                                            onClick={() => setTpls(v => (on ? v.filter(x => x !== t.id) : [...v, t.id]))}>
                                            <span className={`h-4 w-4 shrink-0 rounded border bond-hair grid place-items-center ${on ? 'bg-[var(--bond-accent)] text-[var(--bond-on-accent)]' : ''}`}>{on && <Check size={11} />}</span>
                                            <span className="flex-1 text-[13px]">{templateTitle(t, space.bond.route)}</span>
                                            <span className="text-[11px] text-[var(--bond-muted)]">{st.days} 天 · ＋{st.points}</span>
                                        </button>
                                    );
                                })}
                            </div>
                            <div className="mt-3 flex gap-2">
                                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={filling || !days} onClick={backfill}>
                                    <ArrowCounterClockwise size={14} />{filling ? '補算中…' : `補算（約 ＋${fillPoints}，另加成就）`}
                                </button>
                            </div>
                            {reviewed?.backfilledAt && <p className="mt-2 text-[11px] text-[var(--bond-muted)]">{dayKeyOf(reviewed.backfilledAt)} 補算過；再補一次只會補還沒記的。</p>}
                        </>
                    )}
                </section>

                {!reviewed && (
                    <section>
                        <SectionLabel>或 者</SectionLabel>
                        <button type="button" className="bond-btn" onClick={skip}>都不用，從現在開始算</button>
                    </section>
                )}
            </div>
        </div>
    );
};
