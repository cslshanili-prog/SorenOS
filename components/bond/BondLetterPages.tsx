/**
 * 珍藏 · 信件（plans/bond-batch5.md 第 3 節）：清單（珍藏分頁裡的「信件」）、讀信（拆信）、寫信（全螢幕）、特別時光那封。
 * 純判斷在 utils/bond/letter.ts，寄出與投遞在 components/bond/letterRun.ts。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowBendUpLeft, ChatCircleText, Feather, PencilSimple, Sparkle, Trash } from '@phosphor-icons/react';
import type { BondEntry, SpecialMomentRecord } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import { Envelope, type EnvelopeStage } from './treasure/Envelope';
import { postUserLetter } from './letterRun';
import {
    awaitingReply, editLetter, letterArrived, letterExcerpt, letterInTransit, letterPaper, lettersForUser, letterThread, letterTime,
    LETTER_PAPERS, markLetterRead, newLetter, SLOW_DAYS, waxFor,
} from '../../utils/bond/letter';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { useBlobRefUrl } from '../../utils/blobRef';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const DAY = 86400_000;
const md = (ms: number) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()}`; };
const fullDay = (ms: number) => { const d = new Date(ms); return `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日`; };
const firstChar = (name: string) => Array.from(name.trim())[0] || '・';
const wait = (ms: number) => new Promise(r => setTimeout(r, ms));
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

const Footer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>{children}</div>
);

// ─── 特別時光（情人節、520…）：讀角色卡上這條線的紀錄，唯讀 ───

const SPECIAL_LABEL: Array<{ re: RegExp; label: string }> = [
    { re: /^valentine/, label: '情人節' }, { re: /^whiteday/, label: '白色情人節' }, { re: /^like520/, label: '520' }, { re: /^qixi/, label: '七夕' },
];
export const specialLabel = (key: string) => SPECIAL_LABEL.find(x => x.re.test(key))?.label || '特別時光';

export function specialMomentsOf(space: ResolvedSpace): Array<{ key: string; record: SpecialMomentRecord }> {
    const recs = (space.view || space.char).specialMomentRecords || {};
    return Object.entries(recs)
        .filter(([, r]) => r && (r.content?.trim() || r.image))
        .map(([key, record]) => ({ key, record }))
        .sort((a, b) => (b.record.timestamp || 0) - (a.record.timestamp || 0));
}

// ─── 清單 ─────────────────────────────────────────

/** 信的一行（小信封＋誰寫的＋狀態） */
const LetterRow: React.FC<{ space: ResolvedSpace; e: BondEntry; onOpen: () => void }> = ({ space, e, onOpen }) => {
    const mine = e.author === 'user';
    const draft = e.status === 'draft';
    const transit = letterInTransit(e);
    const unread = !mine && !e.letter!.readAt;
    const who = mine ? `寫給${space.rightName}` : `${space.rightName}寫給你`;
    const status = draft ? '草稿' : transit ? `寄出中・預計 ${md(e.letter!.deliverAt!)} 到` : mine ? (e.letter!.readAt ? `${md(letterTime(e))} 寄到・TA 讀過了` : `${md(letterTime(e))} 寄到`) : `${md(letterTime(e))}${unread ? '・還沒拆' : ''}`;
    return (
        <button type="button" onClick={onOpen} className={`w-full flex items-center gap-3.5 py-3 text-left ${draft ? 'opacity-75' : ''}`}>
            <Envelope paperStyle={e.letter!.paperStyle} wax={waxFor(e.id)} initial={firstChar(mine ? space.leftName : space.rightName)} scale={0.24}
                stage={!mine && !unread ? 'cracked' : 'closed'} />
            <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5">
                    <span className="bond-serif text-[14px] truncate">{who}</span>
                    {unread && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--bond-accent)]" aria-label="還沒拆" />}
                </span>
                <span className="block text-[11.5px] text-[var(--bond-muted)] truncate">{unread ? '（還沒拆開）' : letterExcerpt(e.text, 26) || '（空白）'}</span>
                <span className={`block text-[10.5px] ${transit || draft ? 'text-[var(--bond-accent)]' : 'text-[var(--bond-muted)]'}`}>{status}</span>
            </span>
        </button>
    );
};

export const LetterTab: React.FC<{
    space: ResolvedSpace;
    onOpen: (letterId: string) => void;
    onWrite: () => void;
    onOpenSpecial: (key: string) => void;
    /** 主動產出「信」的設定 */
    onOpenSettings: () => void;
}> = ({ space, onOpen, onWrite, onOpenSpecial, onOpenSettings }) => {
    const entries = useBondEntries(space.id);
    const letters = useMemo(() => lettersForUser(entries), [entries]);
    const drafts = letters.filter(e => e.status === 'draft');
    const sent = letters.filter(e => e.status !== 'draft');
    const specials = specialMomentsOf(space);
    return (
        <div className="px-5 pt-4 pb-12">
            <button type="button" onClick={onWrite} className="w-full flex items-center gap-2 rounded-xl border bond-hair bg-[var(--bond-card)] px-3.5 py-3 text-left">
                <Feather size={16} className="text-[var(--bond-accent)] shrink-0" />
                <span className="min-w-0"><span className="bond-serif block text-[13.5px]">寫一封信給{space.rightName}</span><span className="block text-[11px] text-[var(--bond-muted)] truncate">可以馬上寄到，也可以慢慢寄</span></span>
            </button>
            {(() => {
                const own = space.bond.output?.letter;
                const on = own?.enabled === true;
                return (
                    <button type="button" onClick={onOpenSettings} className="mt-2 w-full text-left text-[11.5px] text-[var(--bond-muted)]">
                        {space.rightName}主動寫信：{on && own?.everyDays ? `大約每 ${own.everyDays[0]}～${own.everyDays[1]} 天一封` : '關著'}<span className="ml-1 text-[var(--bond-accent)]">設定 ›</span>
                    </button>
                );
            })()}
            {drafts.length > 0 && (
                <section className="mt-5">
                    <SectionLabel>草 稿</SectionLabel>
                    <div className="divide-y bond-hair">{drafts.map(e => <LetterRow key={e.id} space={space} e={e} onOpen={() => onOpen(e.id)} />)}</div>
                </section>
            )}
            <section className="mt-5">
                <SectionLabel>往 來</SectionLabel>
                {sent.length ? (
                    <div className="divide-y bond-hair">{sent.map(e => <LetterRow key={e.id} space={space} e={e} onOpen={() => onOpen(e.id)} />)}</div>
                ) : (
                    <p className="py-8 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">還沒有信。比紙條長、比聊天慢的話，可以寫在這裡。</p>
                )}
            </section>
            {specials.length > 0 && (
                <section className="mt-6">
                    <SectionLabel>特 別 時 光</SectionLabel>
                    <div className="divide-y bond-hair">
                        {specials.map(s => (
                            <button key={s.key} type="button" onClick={() => onOpenSpecial(s.key)} className="w-full flex items-center gap-3 py-3 text-left">
                                <Sparkle size={16} className="text-[var(--bond-accent)] shrink-0" />
                                <span className="min-w-0 flex-1">
                                    <span className="bond-serif block text-[14px]">{specialLabel(s.key)}那封</span>
                                    <span className="block text-[11.5px] text-[var(--bond-muted)] truncate">{s.record.timestamp ? fullDay(s.record.timestamp) : ''}{s.record.content ? `・${letterExcerpt(s.record.content, 20)}` : ''}</span>
                                </span>
                            </button>
                        ))}
                    </div>
                </section>
            )}
        </div>
    );
};

// ─── 讀信 ─────────────────────────────────────────

/** 一張信紙（全版） */
export const LetterSheet: React.FC<{ e: BondEntry; fromName: string; toName: string; className?: string }> = ({ e, fromName, toName, className = '' }) => {
    const p = letterPaper(e.letter?.paperStyle);
    const at = e.letter?.sentAt || e.writtenAt;
    return (
        <article className={`bond-letter-sheet ${className}`} style={{ background: p.bg, color: p.ink, backgroundImage: p.line || undefined, backgroundSize: p.size || undefined }}>
            <div className="mb-3 text-[11px] tracking-[0.2em] opacity-55" style={{ fontFamily: 'var(--app-font)' }}>{fullDay(at)} · {fromName} 寫給 {toName}</div>
            <div>{e.text || '（空白）'}</div>
            <div className="mt-5 text-right">——{e.letter?.signature || fromName}</div>
        </article>
    );
};

export const BondLetterPage: React.FC<{
    space: ResolvedSpace;
    letterId: string;
    onBack: () => void;
    onReply: (letterId: string) => void;
    onEditDraft: (letterId: string) => void;
    onOpen: (letterId: string) => void;
    /** 請 TA 回信（5b-3）：還沒設篇幅時照 300～800 字 */
    onAskReply?: (letter: BondEntry) => Promise<void>;
    onBringToChat?: (letter: BondEntry) => void;
    addToast: Toast;
}> = ({ space, letterId, onBack, onReply, onEditDraft, onOpen, onAskReply, onBringToChat, addToast }) => {
    const entries = useBondEntries(space.id);
    const e = entries.find(x => x.id === letterId) || bondEntryById(letterId);
    const fresh = !!e && e.author !== 'user' && letterArrived(e) && !e.letter!.readAt;
    const [stage, setStage] = useState<EnvelopeStage | 'read'>(fresh ? 'closed' : 'read');
    const [asking, setAsking] = useState(false);

    useEffect(() => { setStage(fresh ? 'closed' : 'read'); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [letterId]);

    if (!e?.letter) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="信" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這封信已經不在了。</div>
            </div>
        );
    }
    const mine = e.author === 'user';
    const fromName = mine ? space.leftName : space.rightName;
    const toName = mine ? space.rightName : space.leftName;
    const thread = letterThread(entries, e.id, 'user');
    const others = thread.filter(x => x.id !== e.id);
    const last = thread[thread.length - 1];
    const transit = letterInTransit(e);

    const unseal = async () => {
        if (reducedMotion()) { setStage('read'); }
        else {
            setStage('cracked'); await wait(420);
            setStage('open'); await wait(600);
            setStage('out'); await wait(950);
            setStage('read');
        }
        await saveBondEntry(markLetterRead(e));
    };

    const canReply = !mine && letterArrived(e) && last?.id === e.id;
    const canAsk = mine && letterArrived(e) && awaitingReply(entries, e) && !!onAskReply;
    const ask = async () => {
        if (!onAskReply) return;
        setAsking(true);
        try { await onAskReply(e); } catch (err: any) { addToast(err?.message || '沒寫成', 'error'); } finally { setAsking(false); }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={e.status === 'draft' ? '草稿' : mine ? `寫給${space.rightName}` : `${space.rightName}的信`} onBack={onBack}
                right={e.status === 'draft' ? <button type="button" className="text-[12.5px] text-[var(--bond-accent)] px-2" onClick={() => onEditDraft(e.id)}>繼續寫</button> : undefined} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6">
                {stage !== 'read' ? (
                    <div className="flex flex-col items-center pt-24">
                        <Envelope paperStyle={e.letter.paperStyle} wax={waxFor(e.id)} initial={firstChar(fromName)} stage={stage} heading={`給${toName}`} onClick={stage === 'closed' ? unseal : undefined} />
                        <p className="mt-6 text-[12px] text-[var(--bond-muted)]">{fullDay(letterTime(e))} 到的</p>
                        {stage === 'closed' && <button type="button" className="bond-btn bond-btn-primary mt-3" onClick={unseal}>拆開</button>}
                    </div>
                ) : (
                    <>
                        {transit && (
                            <div className="mb-5 flex flex-col items-center">
                                <Envelope paperStyle={e.letter.paperStyle} wax={waxFor(e.id)} initial={firstChar(fromName)} scale={0.6} postmark={`寄出中\n預計\n${md(e.letter.deliverAt!)}`} />
                                <p className="mt-3 text-[12px] text-[var(--bond-muted)]">還在路上，{space.rightName}還沒收到，也還不知道寫了什麼。</p>
                            </div>
                        )}
                        <LetterSheet e={e} fromName={fromName} toName={toName} />
                        {mine && letterArrived(e) && <p className="mt-3 text-right text-[11px] text-[var(--bond-muted)]">{fullDay(e.letter.arrivedAt!)} 寄到，{space.rightName}讀過了</p>}
                        {others.length > 0 && (
                            <section className="mt-8">
                                <SectionLabel>這 一 串</SectionLabel>
                                <ol className="space-y-2 border-l border-[var(--bond-line)] pl-3">
                                    {thread.map(x => (
                                        <li key={x.id}>
                                            <button type="button" disabled={x.id === e.id} onClick={() => onOpen(x.id)} className={`w-full text-left ${x.id === e.id ? 'opacity-50' : ''}`}>
                                                <span className="block text-[10.5px] text-[var(--bond-muted)]">{md(letterTime(x))}・{x.author === 'user' ? '你' : space.rightName}{x.status === 'draft' ? '（草稿）' : letterInTransit(x) ? '（寄出中）' : ''}{x.id === e.id ? '・這封' : ''}</span>
                                                <span className="bond-serif block text-[13px] truncate">{x.author !== 'user' && !x.letter!.readAt ? '（還沒拆開）' : letterExcerpt(x.text, 30)}</span>
                                            </button>
                                        </li>
                                    ))}
                                </ol>
                            </section>
                        )}
                    </>
                )}
            </div>
            {stage === 'read' && e.status !== 'draft' && (
                <Footer>
                    {canReply && <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={() => onReply(e.id)}><ArrowBendUpLeft size={14} />回信</button>}
                    {canAsk && <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={asking} onClick={ask}><Feather size={14} />{asking ? `${space.rightName}在寫…` : `請${space.rightName}回信`}</button>}
                    {onBringToChat && letterArrived(e) && <button type="button" className="bond-btn flex-1" onClick={() => onBringToChat(e)}><ChatCircleText size={14} />帶去聊聊</button>}
                </Footer>
            )}
        </div>
    );
};

// ─── 寫信 ─────────────────────────────────────────

export const BondLetterComposePage: React.FC<{
    space: ResolvedSpace;
    /** 繼續寫的草稿 */
    entryId?: string;
    /** 回哪一封 */
    replyTo?: string;
    onBack: () => void;
    onDone: (letterId: string) => void;
    addToast: Toast;
}> = ({ space, entryId, replyTo, onBack, onDone, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const reply = replyTo ? bondEntryById(replyTo) : existing?.letter?.replyTo ? bondEntryById(existing.letter.replyTo) : undefined;
    const [text, setText] = useState(existing?.text || '');
    const [paper, setPaper] = useState<string>(existing?.letter?.paperStyle || reply?.letter?.paperStyle || 'plain');
    const [signature, setSignature] = useState(existing?.letter?.signature || '');
    const [slow, setSlow] = useState(0);
    const [busy, setBusy] = useState(false);
    const [showReply, setShowReply] = useState(false);
    const p = letterPaper(paper);

    const draftOf = (): BondEntry => {
        const base = existing || newLetter({ bondId: space.id, author: 'user', to: space.char.id, text: '', replyTo: reply?.id });
        return editLetter(base, { text, paperStyle: paper, signature });
    };
    const saveDraft = async () => {
        setBusy(true);
        try { const d = await saveBondEntry(draftOf()); addToast('存成草稿了', 'success'); onDone(d.id); }
        catch (err: any) { addToast(`沒存成：${err?.message || err}`, 'error'); setBusy(false); }
    };
    const send = async () => {
        if (!text.trim()) return;
        setBusy(true);
        try {
            const sent = await postUserLetter({ id: space.id, char: space.char, personaKey: space.personaKey }, draftOf(), slow);
            addToast(slow ? `寄出了，預計 ${md(Date.now() + slow * DAY)} 到` : `寄到了，${space.rightName}收到了`, 'success');
            onDone(sent.id);
        } catch (err: any) {
            addToast(`沒寄成：${err?.message || err}`, 'error');
            setBusy(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={reply ? `回信給${space.rightName}` : `寫給${space.rightName}`} onBack={onBack} backLabel="取消"
                right={existing ? <button type="button" aria-label="刪掉草稿" className="h-9 w-9 grid place-items-center text-[var(--bond-muted)]" onClick={async () => { await deleteBondEntries([existing.id]); addToast('草稿刪掉了', 'success'); onBack(); }}><Trash size={16} /></button> : undefined} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 space-y-5">
                {reply && (
                    <button type="button" className="w-full text-left rounded-xl border bond-hair bg-[var(--bond-card)] px-3.5 py-2.5" onClick={() => setShowReply(v => !v)}>
                        <span className="block text-[10.5px] tracking-wider text-[var(--bond-muted)]">回 {reply.author === 'user' ? '你自己' : space.rightName} {md(letterTime(reply))} 的信</span>
                        <span className={`bond-serif block text-[13px] text-[var(--bond-ink-2)] ${showReply ? 'whitespace-pre-wrap' : 'truncate'}`}>{showReply ? reply.text : letterExcerpt(reply.text, 40)}</span>
                    </button>
                )}
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
                    <div className="mb-2 text-[11px] tracking-[0.2em] opacity-55">給 {space.rightName}</div>
                    <textarea value={text} onChange={e => setText(e.target.value)} placeholder="想說的話，慢慢寫。" maxLength={6000}
                        className="w-full min-h-[46vh] resize-none bg-transparent outline-none bond-serif text-[15px] leading-[2] placeholder:opacity-40" style={{ color: p.ink }} />
                    <div className="mt-2 flex items-center justify-end gap-1 bond-serif text-[14px]">
                        <span className="opacity-60">——</span>
                        <input value={signature} onChange={e => setSignature(e.target.value)} placeholder={space.leftName} maxLength={30}
                            className="w-36 bg-transparent outline-none text-right placeholder:opacity-40" style={{ color: p.ink }} />
                    </div>
                </div>
                <p className="text-right text-[10.5px] text-[var(--bond-muted)]">{Array.from(text).length} 字</p>
                <section>
                    <SectionLabel>怎 麼 寄</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className="bond-chip" aria-pressed={slow === 0} onClick={() => setSlow(0)}>馬上到</button>
                        {Array.from({ length: SLOW_DAYS[1] - SLOW_DAYS[0] + 1 }, (_, i) => SLOW_DAYS[0] + i).map(d => (
                            <button key={d} type="button" className="bond-chip" aria-pressed={slow === d} onClick={() => setSlow(d)}>慢寄 {d} 天</button>
                        ))}
                    </div>
                    <p className="mt-1.5 text-[11px] text-[var(--bond-muted)]">{slow ? `預計 ${md(Date.now() + slow * DAY)} 到；到之前${space.rightName}只知道有一封信在路上，不知道內容。` : `寄出就到，${space.rightName}下次聊天就讀過了。`}</p>
                </section>
            </div>
            <Footer>
                <button type="button" className="bond-btn flex-1" disabled={busy} onClick={saveDraft}><PencilSimple size={14} />存草稿</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !text.trim()} onClick={send}><Feather size={14} />{busy ? '寄出中…' : '寄出'}</button>
            </Footer>
        </div>
    );
};

// ─── 特別時光那封 ─────────────────────────────────

export const BondSpecialMomentPage: React.FC<{ space: ResolvedSpace; recordKey: string; onBack: () => void }> = ({ space, recordKey, onBack }) => {
    const rec = specialMomentsOf(space).find(s => s.key === recordKey)?.record;
    const img = useBlobRefUrl(rec?.image);
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={`${specialLabel(recordKey)}那封`} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6 space-y-5">
                {!rec ? <p className="py-16 text-center text-[13px] text-[var(--bond-muted)]">這封不在了。</p> : (
                    <>
                        {img && <img src={img} alt="" className="w-full rounded-lg shadow-sm" />}
                        {rec.content && (
                            <article className="bond-letter-sheet" style={{ background: '#fbf8f3', color: '#463f3a' }}>
                                <div className="mb-3 text-[11px] tracking-[0.2em] opacity-55" style={{ fontFamily: 'var(--app-font)' }}>{rec.timestamp ? fullDay(rec.timestamp) : ''} · {space.rightName}</div>
                                <div>{rec.content}</div>
                            </article>
                        )}
                        <p className="text-center text-[11px] text-[var(--bond-muted)]">{specialLabel(recordKey)}活動留下的，這裡只是收著看。</p>
                    </>
                )}
            </div>
        </div>
    );
};
