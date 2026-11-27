/**
 * 珍藏 · 留給以後（plans/bond-batch5.md 第 4 節）：清單、一封（封著：封條＋小牌子；到期拆開的儀式；提前打開）、封一封（全螢幕）。
 * 純判斷在 utils/bond/capsule.ts，封存、請 TA 也寫、拆開在 components/bond/capsuleRun.ts。
 */
import React, { useMemo, useState } from 'react';
import { ChatCircleText, Images, LockSimple, Feather } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CalendarEvent } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import { Envelope, type EnvelopeStage } from './treasure/Envelope';
import { CapsuleBand } from './treasure/CapsuleBand';
import { BondPhotoPicker, BondPhotoStrip } from './BondPhotoPicker';
import { askCharCapsule, capsuleCtxOf, openCapsuleNow, sealUserCapsule } from './capsuleRun';
import {
    canOpen, capsuleList, capsuleOpened, capsulePair, capsuleSealed, conditionText, daysLeft, newCapsule, yearLater, type CapsuleOpenWhen,
} from '../../utils/bond/capsule';
import { LETTER_PAPERS, letterExcerpt, letterPaper, waxFor } from '../../utils/bond/letter';
import { upcomingAnniversaries } from '../../utils/bond/spaces';
import { stagesOf, stageLabel, CUSTOM_STAGE } from '../../utils/bond/routes';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const fullDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const firstChar = (name: string) => Array.from(name.trim())[0] || '・';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const Footer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>{children}</div>
);

/** 小牌子上那行：還有幾天／今天可以打開了／條件 */
export function capsuleWhenText(e: BondEntry, today: string): string {
    const c = e.capsule!;
    if (c.openedAt) return `${fullDay(c.openedAt)} 拆開${c.openedEarly ? '（提前）' : ''}`;
    if (c.dueAt) return '今天可以打開了';
    const left = daysLeft(c.openWhen, today);
    return left !== null ? `還有 ${left} 天` : conditionText(c.openWhen);
}

const whoLine = (e: BondEntry, space: ResolvedSpace) => (e.capsule!.to === 'both' ? '我們一起的' : e.author === 'user' ? `給${space.rightName}的` : `${space.rightName}給你的`);

/** 封著的信封（封條＋小牌子） */
const CapsuleEnvelope: React.FC<{ e: BondEntry; space: ResolvedSpace; stage?: EnvelopeStage; torn?: boolean; scale?: number; onClick?: () => void }> = ({ e, space, stage = 'closed', torn, scale, onClick }) => {
    const c = e.capsule!;
    const due = !!c.dueAt && !c.openedAt;
    return (
        <Envelope paperStyle={c.paperStyle} wax={waxFor(e.id)} initial={firstChar(e.author === 'user' ? space.leftName : space.rightName)} stage={stage} scale={scale} onClick={onClick}
            className={`capsule ${due ? 'due' : ''} ${torn ? 'torn' : ''}`} heading="給以後"
            band={<CapsuleBand cover={c.cover} when={capsuleWhenText(e, space.todayKey)} due={due} locked={!c.dueAt} />} />
    );
};

// ─── 清單 ─────────────────────────────────────────

export const CapsuleTab: React.FC<{ space: ResolvedSpace; onOpen: (id: string) => void; onSeal: () => void }> = ({ space, onOpen, onSeal }) => {
    const entries = useBondEntries(space.id);
    const list = useMemo(() => capsuleList(entries), [entries]);
    const sealed = list.filter(capsuleSealed);
    const opened = list.filter(capsuleOpened);
    const Row: React.FC<{ e: BondEntry }> = ({ e }) => {
        const due = !!e.capsule!.dueAt && !e.capsule!.openedAt;
        return (
            <button type="button" onClick={() => onOpen(e.id)} className="w-full flex items-center gap-3.5 py-3 text-left">
                <Envelope paperStyle={e.capsule!.paperStyle} wax={waxFor(e.id)} initial={firstChar(e.author === 'user' ? space.leftName : space.rightName)} scale={0.24}
                    stage={capsuleOpened(e) ? 'cracked' : 'closed'} className="capsule"
                    band={capsuleOpened(e) ? undefined : <div className="cap-band" aria-hidden="true"><span className="bl">留 給 以</span><span className="br">後</span></div>} />
                <span className="min-w-0 flex-1">
                    <span className="bond-serif block text-[14px] truncate">{whoLine(e, space)}{due && <span className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[var(--bond-accent)] align-middle" aria-label="可以打開了" />}</span>
                    <span className="block text-[11.5px] text-[var(--bond-muted)] truncate">{capsuleOpened(e) ? letterExcerpt(e.text, 26) : e.capsule!.cover || conditionText(e.capsule!.openWhen)}</span>
                    <span className={`block text-[10.5px] ${due ? 'text-[var(--bond-accent)]' : 'text-[var(--bond-muted)]'}`}>{capsuleWhenText(e, space.todayKey)}</span>
                </span>
            </button>
        );
    };
    return (
        <div className="px-5 pt-4 pb-12">
            <button type="button" onClick={onSeal} className="w-full flex items-center gap-2 rounded-xl border bond-hair bg-[var(--bond-card)] px-3.5 py-3 text-left">
                <LockSimple size={16} className="text-[var(--bond-accent)] shrink-0" />
                <span className="min-w-0"><span className="bond-serif block text-[13.5px]">封一封留給以後</span><span className="block text-[11px] text-[var(--bond-muted)] truncate">約好某一天、某個紀念日、某個階段再打開</span></span>
            </button>
            <section className="mt-5">
                <SectionLabel>封 著 的</SectionLabel>
                {sealed.length ? <div className="divide-y bond-hair">{sealed.map(e => <Row key={e.id} e={e} />)}</div>
                    : <p className="py-8 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">還沒有封著的。寫給以後的你們，封起來、到那天再一起看。</p>}
            </section>
            {opened.length > 0 && (
                <section className="mt-5">
                    <SectionLabel>拆 開 了</SectionLabel>
                    <div className="divide-y bond-hair">{opened.map(e => <Row key={e.id} e={e} />)}</div>
                </section>
            )}
        </div>
    );
};

// ─── 一封 ─────────────────────────────────────────

const CapsuleSheet: React.FC<{ e: BondEntry; fromName: string; toName: string }> = ({ e, fromName, toName }) => {
    const c = e.capsule!;
    const p = letterPaper(c.paperStyle);
    return (
        <article className="bond-letter-sheet" style={{ background: p.bg, color: p.ink, backgroundImage: p.line || undefined, backgroundSize: p.size || undefined }}>
            <div className="mb-3 text-[11px] tracking-[0.2em] opacity-55" style={{ fontFamily: 'var(--app-font)' }}>{fullDay(c.sealedAt)} 封 · {fromName} 寫給以後的 {toName}</div>
            <div>{e.text}</div>
            <div className="mt-5 text-right">——{c.signature || fromName}</div>
        </article>
    );
};

export const BondCapsulePage: React.FC<{
    space: ResolvedSpace;
    capsuleId: string;
    apiConfig: APIConfig;
    onBack: () => void;
    onBringToChat?: (e: BondEntry) => void;
    addToast: Toast;
}> = ({ space, capsuleId, apiConfig, onBack, onBringToChat, addToast }) => {
    const entries = useBondEntries(space.id);
    const e = entries.find(x => x.id === capsuleId);
    const [stage, setStage] = useState<EnvelopeStage | 'read' | null>(null);
    const [torn, setTorn] = useState(false);
    const [confirmEarly, setConfirmEarly] = useState(false);
    const [busy, setBusy] = useState(false);

    if (!e?.capsule) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="留給以後" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這封不在了。</div>
            </div>
        );
    }
    const c = e.capsule;
    const pair = capsulePair(entries, e);
    const opened = capsuleOpened(e);
    const view = stage ?? (opened ? 'read' : 'closed');
    const can = canOpen(e);
    const waitingPair = c.to === 'both' && e.author === 'user' && !c.pairWith;
    const nameOf = (x: BondEntry) => (x.author === 'user' ? space.leftName : space.rightName);
    const toOf = (x: BondEntry) => (x.capsule!.to === 'both' ? (x.author === 'user' ? space.rightName : space.leftName) : x.capsule!.to === 'user' ? space.leftName : space.rightName);

    const open = async () => {
        setConfirmEarly(false);
        setBusy(true);
        try {
            if (!reducedMotion()) {
                setTorn(true); await wait(520);
                setStage('cracked'); await wait(420);
                setStage('open'); await wait(600);
                setStage('out'); await wait(950);
            }
            await openCapsuleNow(space, e);
            setStage('read');
        } catch (err: any) {
            addToast(`沒拆成：${err?.message || err}`, 'error');
            setStage(null); setTorn(false);
        } finally { setBusy(false); }
    };
    const askPair = async () => {
        setBusy(true);
        try {
            await askCharCapsule(space, apiConfig, { openWhen: c.openWhen, together: e });
            addToast(`${space.rightName}也封好了一封，到時候一起拆`, 'success');
        } catch (err: any) { addToast(err?.message || '沒寫成', 'error'); }
        finally { setBusy(false); }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={whoLine(e, space)} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6">
                {view !== 'read' ? (
                    <div className="flex flex-col items-center pt-20">
                        <CapsuleEnvelope e={e} space={space} stage={view} torn={torn} />
                        <div className="mt-24 w-full space-y-2 text-center text-[12px] leading-relaxed text-[var(--bond-muted)]">
                            <p>{fullDay(c.sealedAt)} 封的・約好 {conditionText(c.openWhen)} 打開</p>
                            {e.author === 'user' && <p>封好之後你自己也看不到內容了。</p>}
                            {c.to === 'both' && <p>{pair ? `${space.rightName}也封了一封，到時候一起拆。` : `${space.rightName}那封還沒寫。`}</p>}
                            {!can.now && !can.early && e.author === 'user' && c.to !== 'both' && <p>這封是給{space.rightName}的，到了那天才能拆。</p>}
                        </div>
                        {confirmEarly && (
                            <div className="mt-4 w-full rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3 text-[12.5px] leading-relaxed">
                                還沒到約好的那天（{conditionText(c.openWhen)}）。現在拆的話會記下「提前打開」，{space.rightName}也會知道。
                                <div className="mt-3 flex gap-2">
                                    <button type="button" className="bond-btn flex-1" onClick={() => setConfirmEarly(false)}>再等等</button>
                                    <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={open}>現在拆</button>
                                </div>
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="space-y-6">
                        <CapsuleSheet e={e} fromName={nameOf(e)} toName={toOf(e)} />
                        {pair && capsuleOpened(pair) && <CapsuleSheet e={pair} fromName={nameOf(pair)} toName={toOf(pair)} />}
                        {c.photos?.length ? <BondPhotoStrip galleryIds={c.photos} size="sm" /> : null}
                        <p className="text-center text-[11px] text-[var(--bond-muted)]">{fullDay(c.openedAt || Date.now())} 拆開{c.openedEarly ? '・提前打開' : ''}</p>
                    </div>
                )}
            </div>
            <Footer>
                {view === 'read' ? (
                    onBringToChat ? <button type="button" className="bond-btn flex-1" onClick={() => onBringToChat(e)}><ChatCircleText size={14} />帶去聊聊</button> : <span className="flex-1" />
                ) : waitingPair ? (
                    <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy} onClick={askPair}><Feather size={14} />{busy ? `${space.rightName}在寫…` : `請${space.rightName}也封一封`}</button>
                ) : can.now ? (
                    <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy} onClick={open}>拆開</button>
                ) : can.early ? (
                    <button type="button" className="bond-btn flex-1" disabled={busy || confirmEarly} onClick={() => setConfirmEarly(true)}>等不及了</button>
                ) : <span className="flex-1 text-center text-[12px] text-[var(--bond-muted)] py-2">{capsuleWhenText(e, space.todayKey)}</span>}
            </Footer>
        </div>
    );
};

// ─── 封一封 ───────────────────────────────────────

type WhenKind = CapsuleOpenWhen['kind'];

export const BondCapsuleComposePage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    events: CalendarEvent[];
    onBack: () => void;
    onDone: (id: string) => void;
    addToast: Toast;
}> = ({ space, apiConfig, events, onBack, onDone, addToast }) => {
    const ctx = capsuleCtxOf(space);
    const [together, setTogether] = useState(false);
    const [text, setText] = useState('');
    const [paper, setPaper] = useState<string>('lined');
    const [signature, setSignature] = useState('');
    const [cover, setCover] = useState('');
    const [kind, setKind] = useState<WhenKind>('date');
    const [date, setDate] = useState(yearLater(space.todayKey));
    const anniversaries = useMemo(() => upcomingAnniversaries(events, { charIds: [space.char.id], personaKey: space.personaKey }, space.todayKey, 6).filter(a => a.daysLeft > 0), [events, space]);
    const [annId, setAnnId] = useState<string>('');
    const [level, setLevel] = useState(ctx.level + 1);
    const laterStages = stagesOf(space.bond.route).filter(s => s.id !== CUSTOM_STAGE).filter((s, i, all) => i > all.findIndex(x => x.id === space.bond.stage));
    const [stageId, setStageId] = useState(laterStages[0]?.id || '');
    const [photos, setPhotos] = useState<string[]>([]);
    const [picking, setPicking] = useState(false);
    const [confirm, setConfirm] = useState(false);
    const [busy, setBusy] = useState(false);
    const p = letterPaper(paper);

    const openWhen = (): CapsuleOpenWhen | null => {
        if (kind === 'date') return date > space.todayKey ? { kind: 'date', date } : null;
        if (kind === 'anniversary') {
            const a = anniversaries.find(x => x.event.id + x.date === annId);
            return a ? { kind: 'anniversary', eventId: a.event.id, title: a.event.title, date: a.date } : null;
        }
        if (kind === 'level') return level > ctx.level ? { kind: 'level', level } : null;
        const st = laterStages.find(s => s.id === stageId);
        return st ? { kind: 'stage', stage: st.id, label: st.label } : null;
    };
    const when = openWhen();

    const seal = async () => {
        if (!when || !text.trim()) return;
        setBusy(true);
        try {
            const mine = await sealUserCapsule(space, newCapsule({
                bondId: space.id, author: 'user', to: together ? 'both' : space.char.id, text: text.trim(), openWhen: when,
                cover, paperStyle: paper, signature, photos, origin: together ? 'together' : 'manual',
            }));
            if (together) {
                try {
                    await askCharCapsule(space, apiConfig, { openWhen: when, together: mine });
                    addToast(`封好了。${space.rightName}也封了一封，到時候一起拆`, 'success');
                } catch (err: any) {
                    addToast(`你的封好了；${space.rightName}那封沒寫成（${err?.message || err}），可以在那封裡再請一次`, 'info');
                }
            } else {
                addToast('封好了', 'success');
            }
            onDone(mine.id);
        } catch (err: any) {
            addToast(`沒封成：${err?.message || err}`, 'error');
            setBusy(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="封一封留給以後" onBack={onBack} backLabel="取消" />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 space-y-6">
                <section>
                    <SectionLabel>給 誰</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className="bond-chip" aria-pressed={!together} onClick={() => setTogether(false)}>給{space.rightName}</button>
                        <button type="button" className="bond-chip" aria-pressed={together} onClick={() => setTogether(true)}>我們一起（{space.rightName}也寫一封）</button>
                    </div>
                    <p className="mt-1.5 text-[11px] text-[var(--bond-muted)]">{together ? `封好之後會請${space.rightName}也寫一封給你，兩封約好同一天拆。` : `到了那天，你按「拆開」${space.rightName}才讀得到。`}</p>
                </section>
                <section>
                    <SectionLabel>信 紙</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {LETTER_PAPERS.map(x => (
                            <button key={x.id} type="button" className="bond-chip gap-1.5" aria-pressed={paper === x.id} onClick={() => setPaper(x.id)}>
                                <span className="inline-block h-3 w-3 rounded-full border border-black/10" style={{ background: x.bg }} />{x.name}
                            </button>
                        ))}
                    </div>
                </section>
                <div className="rounded-md px-5 py-5" style={{ background: p.bg, color: p.ink, backgroundImage: p.line || undefined, backgroundSize: p.size || undefined, boxShadow: '0 12px 30px -18px rgba(40,30,30,.45)' }}>
                    <div className="mb-2 text-[11px] tracking-[0.2em] opacity-55">給以後的{together ? '我們' : space.rightName}</div>
                    <textarea value={text} onChange={x => setText(x.target.value)} placeholder="寫給打開那時候的你們。" maxLength={6000}
                        className="w-full min-h-[34vh] resize-none bg-transparent outline-none bond-serif text-[15px] leading-[2] placeholder:opacity-40" style={{ color: p.ink }} />
                    <div className="mt-2 flex items-center justify-end gap-1 bond-serif text-[14px]">
                        <span className="opacity-60">——</span>
                        <input value={signature} onChange={x => setSignature(x.target.value)} placeholder={`現在的${space.leftName}`} maxLength={30}
                            className="w-40 bg-transparent outline-none text-right placeholder:opacity-40" style={{ color: p.ink }} />
                    </div>
                </div>
                <section>
                    <SectionLabel>信 封 上 那 句</SectionLabel>
                    <input className="bond-input bond-serif" value={cover} maxLength={40} onChange={x => setCover(x.target.value)} placeholder="像「等我們一起過完第一年再打開」（雙方都看得到）" />
                </section>
                <section>
                    <SectionLabel>什 麼 時 候 打 開</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {([['date', '某一天'], ['anniversary', '紀念日'], ['level', '羈絆等級'], ['stage', '關係階段']] as Array<[WhenKind, string]>).map(([k, l]) => (
                            <button key={k} type="button" className="bond-chip" aria-pressed={kind === k} onClick={() => setKind(k)}>{l}</button>
                        ))}
                    </div>
                    <div className="mt-3">
                        {kind === 'date' && (
                            <>
                                <input type="date" className="bond-input" value={date} min={space.todayKey} onChange={x => setDate(x.target.value)} />
                                <div className="mt-2 flex gap-2"><button type="button" className="bond-chip" onClick={() => setDate(yearLater(space.todayKey))}>一年後的今天</button></div>
                            </>
                        )}
                        {kind === 'anniversary' && (anniversaries.length ? (
                            <div className="flex flex-wrap gap-2">
                                {anniversaries.map(a => <button key={a.event.id + a.date} type="button" className="bond-chip" aria-pressed={annId === a.event.id + a.date} onClick={() => setAnnId(a.event.id + a.date)}>{a.event.title}・{a.date.slice(5).replace('-', '/')}</button>)}
                            </div>
                        ) : <p className="text-[12px] text-[var(--bond-muted)]">行事曆裡還沒有你們的紀念日。</p>)}
                        {kind === 'level' && (
                            <div className="flex flex-wrap items-center gap-2">
                                {[1, 2, 3, 5, 10].map(d => <button key={d} type="button" className="bond-chip" aria-pressed={level === ctx.level + d} onClick={() => setLevel(ctx.level + d)}>Lv.{ctx.level + d}</button>)}
                                <span className="text-[11px] text-[var(--bond-muted)]">現在 Lv.{ctx.level}</span>
                            </div>
                        )}
                        {kind === 'stage' && (laterStages.length ? (
                            <div className="flex flex-wrap gap-2">
                                {laterStages.map(s => <button key={s.id} type="button" className="bond-chip" aria-pressed={stageId === s.id} onClick={() => setStageId(s.id)}>{s.label}</button>)}
                            </div>
                        ) : <p className="text-[12px] text-[var(--bond-muted)]">現在是「{stageLabel(space.bond)}」，後面沒有階段了（或還沒選路線）。</p>)}
                    </div>
                </section>
                <section>
                    <SectionLabel right={<button type="button" className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1" onClick={() => setPicking(true)}><Images size={12} />從資料庫挑</button>}>一 起 封 進 去 的 照 片</SectionLabel>
                    {photos.length ? <BondPhotoStrip galleryIds={photos} size="sm" /> : <p className="text-[12px] text-[var(--bond-muted)]">可以不放。</p>}
                </section>
                {confirm && (
                    <div className="rounded-xl border bond-hair bg-[var(--bond-accent-soft)] px-4 py-3 text-[12.5px] leading-relaxed">
                        封好之後你自己也看不到內容了，只看得到信封上那句和「{when ? conditionText(when) : ''}」。確定封起來？
                    </div>
                )}
            </div>
            <Footer>
                <button type="button" className="bond-btn flex-1" onClick={() => (confirm ? setConfirm(false) : onBack())}>{confirm ? '再想想' : '取消'}</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !text.trim() || !when}
                    onClick={() => (confirm ? seal() : setConfirm(true))}><LockSimple size={14} />{busy ? (together ? `${space.rightName}也在寫…` : '封存中…') : confirm ? '封起來' : '封存'}</button>
            </Footer>
            {picking && <BondPhotoPicker initial={photos} onBack={() => setPicking(false)} onDone={ids => { setPhotos(ids); setPicking(false); }} />}
        </div>
    );
};
