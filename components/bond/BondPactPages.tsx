/**
 * 約定分頁的全螢幕頁（plans/bond-batch4.md 4.2）：願望、共同約定、默契、里程碑的書寫頁與詳細頁。
 *
 * - 願望：看見不等於答應（「問問 TA 怎麼想」只拿到支持或看法）；談成約定才連上一個約定；完成時連到拾光。
 * - 約定、默契：雙方都說好／確認才成立。你提的按「問問 TA」，角色照人設回應（答應、想改一下、先不要）；
 *   TA 提的在你這邊等你按好。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ChatCircleText, Check, Feather, Flag, Gift, Handshake, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, BondPromiseRepeat, BondTaskCheck, CharacterProfile } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries, useSpaceTimeline } from './useSpaceTimeline';
import { charHabitReply, charPromiseReply, charWishReply } from './heartRun';
import {
    agreePromise, checkLabel, completeWish, confirmHabit, editPromise, HABIT_STATE_LABEL, habitWaitingOn, linkWishToPromise, milestoneKindsFor, milestoneLabel,
    newHabit, newMilestone, newPromise, newWish, PROMISE_STATE_LABEL, PROMISE_TEMPLATES, promiseWaitingOn, publishWish, RECORD_LABEL, repeatLabel,
    replyHabit, replyPromise, retireHabit, setPromiseState, setWishState, supportWish, templateTitle, WISH_STATE_LABEL, wishOwnerLabel,
} from '../../utils/bond/pact';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { dayEventDate, formatEventDate } from '../../utils/bond/eventDate';
import { linkForItem } from '../../utils/bond/essay';
import { DB } from '../../utils/db';
import { charParticipant, newEvent, personaParticipant } from '../../utils/calendarEvents';
import { getLocalDateKey } from '../../utils/localDate';
import { trackEvent } from '../../utils/analytics';
import { useBondLedger } from './useBondLedger';
import { LedgerRowItem } from './BondLedgerPages';
import { recordManually } from './pactRun';
import { donePeriod, isCounted, ledgerKeyOf, promiseStartDay, streakOf } from '../../utils/bond/ledger';
import { addDays, countsOnDay, dayKeyOf, periodKeyOf, periodWord } from '../../utils/bond/period';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const Missing: React.FC<{ title: string; onBack: () => void; what: string }> = ({ title, onBack, what }) => (
    <div className="absolute inset-0 flex flex-col bond-root">
        <BondHeader title={title} onBack={onBack} />
        <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這{what}已經不在了。</div>
    </div>
);

const Footer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>{children}</div>
);

/** 刪除（先問一次） */
const DeleteRow: React.FC<{ label: string; warn: string; onDelete: () => void }> = ({ label, warn, onDelete }) => {
    const [ask, setAsk] = useState(false);
    return !ask ? (
        <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4" onClick={() => setAsk(true)}>{label}</button>
    ) : (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span>{warn}</span>
            <button type="button" className="bond-btn" onClick={() => setAsk(false)}>先不要</button>
            <button type="button" className="bond-btn bond-btn-primary" onClick={onDelete}>刪掉</button>
        </div>
    );
};

/** 對方回應的那句話（引號框） */
const ReplyQuote: React.FC<{ who: string; words: string; tag?: string }> = ({ who, words, tag }) => (
    <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
        <div className="text-[10.5px] tracking-wider text-[var(--bond-muted)]">{who}{tag ? ` · ${tag}` : ''}</div>
        <div className="bond-serif mt-1 whitespace-pre-wrap text-[14px] leading-relaxed">{words}</div>
    </div>
);

// ─── 願望 ─────────────────────────────────────────

export const BondWishComposePage: React.FC<{
    space: ResolvedSpace;
    entryId?: string;
    onBack: () => void;
    onDone: (id: string) => void;
    addToast: Toast;
}> = ({ space, entryId, onBack, onDone, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const name = space.rightName;
    const [owner, setOwner] = useState<'user' | 'both'>(existing?.wish?.owner === 'both' ? 'both' : 'user');
    const [text, setText] = useState(existing?.text || '');
    const [busy, setBusy] = useState(false);
    const editingTheirs = !!existing && existing.author !== 'user';

    const save = async (publish: boolean) => {
        if (!text.trim()) return;
        setBusy(true);
        try {
            const base = existing
                ? { ...existing, text: text.trim(), wish: { ...existing.wish!, ...(editingTheirs ? {} : { owner }) }, updatedAt: Date.now() }
                : newWish({ bondId: space.id, author: 'user', owner, text });
            const saved = await saveBondEntry(publish ? publishWish(base) : base);
            if (!existing && publish) trackEvent('写羁绊愿望', { 谁: '我', 类型: owner === 'both' ? '我们的' : '我的', 方式: '自己写' });
            addToast(publish ? (existing?.status === 'published' ? '改好了' : `發布了，${name}現在知道了`) : '存成草稿了（只有你看得到）', 'success');
            onDone(saved.id);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={existing ? '改願望' : '寫一個願望'} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                {!editingTheirs && (
                    <section>
                        <SectionLabel>誰 的 願 望</SectionLabel>
                        <div className="flex gap-2">
                            <button type="button" className="bond-chip" aria-pressed={owner === 'user'} onClick={() => setOwner('user')}>我的</button>
                            <button type="button" className="bond-chip" aria-pressed={owner === 'both'} onClick={() => setOwner('both')}>我們想一起完成的</button>
                        </div>
                        <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">「我們的」也只是你的想法，{name}要說好才變成約定。</div>
                    </section>
                )}
                <section>
                    <SectionLabel>願 望</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[160px] leading-relaxed" value={text} onChange={e => setText(e.target.value)}
                        placeholder="想去看一次海、想學會做那道菜、想一起熬夜看流星雨……" />
                    {!existing || existing.status === 'draft' ? (
                        <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">發布了{name}才知道；存成草稿只有你看得到。</div>
                    ) : null}
                </section>
            </div>
            <Footer>
                {(!existing || existing.status === 'draft') && <button type="button" className="bond-btn flex-1" disabled={busy || !text.trim()} onClick={() => save(false)}>存草稿</button>}
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !text.trim()} onClick={() => save(true)}>
                    <Feather size={14} />{existing?.status === 'published' ? '存' : '發布'}
                </button>
            </Footer>
        </div>
    );
};

export const BondWishPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    entryId: string;
    onBack: () => void;
    onEdit: () => void;
    onMakePromise: () => void;
    onOpenPromise: (id: string) => void;
    onBringToChat?: (e: BondEntry) => void;
    /** 珍藏（第 5 批）：TA 的願望「我想送這個」→ 打算送；已經打算了就開那件 */
    onPlanGift?: () => void;
    onOpenGift?: (key: string) => void;
    addToast: Toast;
}> = ({ space, characters, apiConfig, entryId, onBack, onEdit, onMakePromise, onOpenPromise, onBringToChat, onPlanGift, onOpenGift, addToast }) => {
    const entries = useBondEntries(space.id);
    const w = entries.find(e => e.id === entryId);
    const name = space.rightName;
    const [busy, setBusy] = useState(false);
    const [picking, setPicking] = useState(false);

    // 打開就算讀過 TA 寫的
    useEffect(() => {
        if (w && w.author !== 'user' && w.status === 'published' && !w.seenAt) void saveBondEntry({ ...w, seenAt: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [w?.id]);

    if (!w || !w.wish) return <Missing title="願望" onBack={onBack} what="個願望" />;
    if (picking) return <WishDonePicker space={space} characters={characters} wish={w} onBack={() => setPicking(false)} addToast={addToast} />;

    const mine = w.author === 'user';
    const promise = w.wish.promiseId ? entries.find(e => e.id === w.wish!.promiseId) : undefined;

    const askTa = async () => {
        setBusy(true);
        try {
            const out = await charWishReply(space, apiConfig, w);
            await saveBondEntry(supportWish(w, space.char.id, out.words, out.stance === 'together'));
            trackEvent('羁绊约定', { 动作: '问问TA', 来源: '愿望', 计分: '否' });
        } catch (e: any) {
            addToast(e?.message || `${name}這次沒回`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const support = async (together: boolean) => {
        await saveBondEntry(supportWish(w, 'user', undefined, together));
        addToast(together ? '你說你也想一起' : '你支持這個願望', 'success');
    };

    const stanceTag = (s: NonNullable<typeof w.wish.support>) => (s.together ? '也想一起' : s.words ? undefined : '支持');

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="願望" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <article className="px-6 pt-7 pb-6 border-b bond-hair">
                    <div className="bond-note">{wishOwnerLabel(w.wish.owner, name)}願望 · {w.status === 'draft' ? '草稿，還沒發布' : WISH_STATE_LABEL[w.wish.state]}</div>
                    <div className="bond-serif mt-4 whitespace-pre-wrap text-[17px] leading-[1.95]">{w.text}</div>
                    <div className="mt-4 flex flex-wrap gap-2">
                        <button type="button" className="bond-btn" onClick={onEdit}>{w.status === 'draft' ? '繼續寫／發布' : '改一改'}</button>
                    </div>
                </article>

                {w.status === 'published' && (
                    <div className="px-5 py-6 space-y-7">
                        <section>
                            <SectionLabel>對 方 怎 麼 想</SectionLabel>
                            {w.wish.support ? (
                                <ReplyQuote who={w.wish.support.by === 'user' ? '你' : name} words={w.wish.support.words || (w.wish.support.together ? '我也想一起。' : '支持你。')} tag={stanceTag(w.wish.support)} />
                            ) : (
                                <p className="text-[12.5px] text-[var(--bond-muted)]">{mine ? `${name}還沒說什麼。` : '你還沒表示。'}</p>
                            )}
                            <div className="mt-3 flex flex-wrap gap-2">
                                {mine ? (
                                    <button type="button" className="bond-btn" disabled={busy} onClick={askTa}><Sparkle size={14} />{busy ? `${name}在想…` : `問問 ${name} 怎麼想`}</button>
                                ) : (
                                    <>
                                        <button type="button" className="bond-btn" onClick={() => support(false)}>我支持</button>
                                        <button type="button" className="bond-btn" onClick={() => support(true)}>我也想一起</button>
                                    </>
                                )}
                            </div>
                            <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">支持不等於答應一起做；要一起做就「談成約定」。</div>
                        </section>

                        <section>
                            <SectionLabel>狀 態</SectionLabel>
                            <div className="flex flex-wrap gap-2">
                                {(['want', 'shelved'] as const).map(st => (
                                    <button key={st} type="button" className="bond-chip" aria-pressed={w.wish!.state === st}
                                        onClick={() => saveBondEntry(setWishState(w, st))}>{WISH_STATE_LABEL[st]}</button>
                                ))}
                                {w.wish.state === 'agreed' && <span className="bond-chip" aria-pressed>{WISH_STATE_LABEL.agreed}</span>}
                                {w.wish.state === 'done' && <span className="bond-chip" aria-pressed>{WISH_STATE_LABEL.done}</span>}
                            </div>
                            {promise ? (
                                <button type="button" className="mt-3 w-full text-left rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3" onClick={() => onOpenPromise(promise.id)}>
                                    <div className="text-[10.5px] tracking-wider text-[var(--bond-muted)]">談成的約定 · {PROMISE_STATE_LABEL[promise.promise!.state]}</div>
                                    <div className="bond-serif mt-1 text-[14px]">{promise.text}</div>
                                </button>
                            ) : w.wish.state !== 'done' && (
                                <button type="button" className="bond-btn mt-3" onClick={onMakePromise}><Handshake size={14} />談成約定</button>
                            )}
                        </section>

                        <section>
                            <SectionLabel>完 成</SectionLabel>
                            {w.wish.state === 'done' ? (
                                <>
                                    <p className="text-[12.5px] text-[var(--bond-ink-2)]">{new Date(w.wish.doneAt || w.updatedAt).toLocaleDateString()} 完成的{w.wish.doneLinks?.length ? `，連到 ${w.wish.doneLinks.length} 件拾光` : ''}。</p>
                                    <button type="button" className="mt-2 text-[11.5px] text-[var(--bond-accent)]" onClick={() => saveBondEntry(setWishState(w, promise ? 'agreed' : 'want'))}>其實還沒完成</button>
                                </>
                            ) : (
                                <button type="button" className="bond-btn" onClick={() => setPicking(true)}><Check size={14} />完成了，連到那時候</button>
                            )}
                        </section>

                        <section className="flex flex-wrap gap-2">
                            {onBringToChat && <button type="button" className="bond-btn" onClick={() => onBringToChat(w)}><ChatCircleText size={14} />帶去聊聊</button>}
                            {(() => {
                                if (w.wish!.owner === 'user' || w.wish!.state === 'done') return null;
                                const gift = entries.find(e => e.kind === 'gift' && e.gift?.fromWishId === w.id && e.gift.dir === 'out');
                                if (gift && onOpenGift) return <button type="button" className="bond-btn" onClick={() => onOpenGift(`e:${gift.id}`)}><Gift size={14} />{gift.gift!.state === 'planned' ? '打算送了，去看看' : '送過了，去看看'}</button>;
                                return onPlanGift ? <button type="button" className="bond-btn" onClick={onPlanGift}><Gift size={14} />我想送這個</button> : null;
                            })()}
                        </section>
                    </div>
                )}

                <div className="px-5 pb-10">
                    <DeleteRow label="刪掉這個願望" warn={`刪掉？${w.status === 'published' ? `${name}之後就不會記得。` : ''}`}
                        onDelete={async () => { await deleteBondEntries([w.id]); onBack(); }} />
                </div>
            </div>
        </div>
    );
};

/** 願望完成：挑拾光裡的那幾件（片刻、記憶），可以一件都不挑 */
const WishDonePicker: React.FC<{ space: ResolvedSpace; characters: CharacterProfile[]; wish: BondEntry; onBack: () => void; addToast: Toast }> = ({ space, characters, wish, onBack, addToast }) => {
    const { items } = useSpaceTimeline(space, characters);
    const candidates = useMemo(() => items.filter(it => !it.hidden && it.kind !== 'essay').slice(0, 40), [items]);
    const [picked, setPicked] = useState<string[]>([]);
    const done = async () => {
        const links = candidates.filter(it => picked.includes(it.key)).flatMap(linkForItem);
        await saveBondEntry(completeWish(wish, links));
        addToast('願望完成了', 'success');
        onBack();
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="連到那時候" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">挑完成這個願望的那幾件事（拾光裡的片刻、記憶）；還沒收存的話可以先不挑，之後再補。</p>
                {candidates.length === 0 ? (
                    <p className="py-12 text-center text-[12.5px] text-[var(--bond-muted)]">拾光裡還沒有東西。</p>
                ) : (
                    <div className="mt-4 divide-y bond-hair border-y">
                        {candidates.map(it => {
                            const on = picked.includes(it.key);
                            return (
                                <button key={it.key} type="button" onClick={() => setPicked(p => (on ? p.filter(x => x !== it.key) : [...p, it.key]))}
                                    className="w-full text-left py-3 flex gap-3" aria-pressed={on}>
                                    <span className={`mt-0.5 h-4 w-4 shrink-0 rounded border bond-hair grid place-items-center ${on ? 'bg-[var(--bond-accent)] text-white' : ''}`}>{on && <Check size={11} />}</span>
                                    <span className="min-w-0">
                                        <span className="block text-[10.5px] tracking-wider text-[var(--bond-muted)]">{formatEventDate(it.eventDate)} · {it.kind === 'moment' ? '片刻' : '記憶'}</span>
                                        <span className="bond-serif block mt-0.5 text-[13.5px] leading-relaxed">{(it.title ? `${it.title}：` : '') + it.text.replace(/\s+/g, ' ').slice(0, 70)}</span>
                                    </span>
                                </button>
                            );
                        })}
                    </div>
                )}
            </div>
            <Footer>
                <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={done}><Check size={14} />{picked.length ? `完成，連到 ${picked.length} 件` : '完成（先不連）'}</button>
            </Footer>
        </div>
    );
};

// ─── 共同約定 ─────────────────────────────────────

type RepeatKind = BondPromiseRepeat['kind'];
const REPEAT_KINDS: Array<{ id: RepeatKind; label: string }> = [
    { id: 'once', label: '一次' }, { id: 'daily', label: '每天' }, { id: 'weekly', label: '每週' }, { id: 'monthly', label: '每月' },
    { id: 'everyNDays', label: '每幾天' }, { id: 'yearly', label: '每年' },
];
type CheckKind = BondTaskCheck['kind'];
const CHECK_KINDS: Array<{ id: CheckKind; label: string; hint: string }> = [
    { id: 'record', label: '照紀錄', hint: '聊天、通話、見面、聽歌、照片、禮物的實際紀錄，自動記' },
    { id: 'keyword', label: '關鍵字', hint: '聊天裡出現這些字就算' },
    { id: 'manual', label: '你確認', hint: '做到了你自己勾' },
    { id: 'ai', label: 'AI 判讀', hint: '一期結束後請 AI 讀那段聊天判斷（副 API）' },
];
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];

export const BondPromiseComposePage: React.FC<{
    space: ResolvedSpace;
    entryId?: string;
    /** 從願望談成約定 */
    fromWishId?: string;
    onBack: () => void;
    onDone: (id: string) => void;
    addToast: Toast;
}> = ({ space, entryId, fromWishId, onBack, onDone, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const wish = fromWishId ? bondEntryById(fromWishId) : undefined;
    const p = existing?.promise;
    const name = space.rightName;
    const [templateId, setTemplateId] = useState<string | undefined>(p?.templateId);
    const [text, setText] = useState(existing?.text || wish?.text || '');
    const [repeat, setRepeat] = useState<BondPromiseRepeat>(p?.repeat || { kind: wish ? 'once' : 'daily' });
    const [check, setCheck] = useState<BondTaskCheck>(p?.check || { kind: 'manual' });
    const [scored, setScored] = useState<boolean>(existing ? !!p?.points : !wish);
    const [points, setPoints] = useState<number>(p?.points || 10);
    const [busy, setBusy] = useState(false);

    const applyTemplate = (id: string) => {
        const t = PROMISE_TEMPLATES.find(x => x.id === id)!;
        setTemplateId(id);
        setText(templateTitle(t, space.bond.route));
        setRepeat(t.repeat);
        setCheck(t.check);
        setScored(true);
        setPoints(t.points);
    };

    const save = async () => {
        if (!text.trim()) return;
        setBusy(true);
        try {
            let saved: BondEntry;
            if (existing) {
                saved = await saveBondEntry(editPromise(existing, { text, repeat, check, points: scored ? points : null }, 'user'));
            } else {
                const e = newPromise({
                    bondId: space.id, author: 'user', text, repeat, check, points: scored ? points : undefined,
                    participants: ['user', space.char.id], fromWishId: wish?.id, templateId,
                });
                saved = await saveBondEntry(e);
                if (wish) await saveBondEntry(linkWishToPromise(wish, e.id));
                trackEvent('羁绊约定', { 动作: '新增', 来源: wish ? '愿望' : templateId ? '模板' : '自己写', 计分: scored ? '是' : '否' });
            }
            addToast(existing ? '改好了' : `提了一個約定，等${name}說好`, 'success');
            onDone(saved.id);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(false);
        }
    };

    const setRepeatKind = (k: RepeatKind) => {
        if (k === 'weekly') setRepeat({ kind: 'weekly', days: [] });
        else if (k === 'everyNDays') setRepeat({ kind: 'everyNDays', n: 3 });
        else if (k === 'yearly') setRepeat({ kind: 'yearly', date: getLocalDateKey(new Date()).slice(5) });
        else setRepeat({ kind: k } as BondPromiseRepeat);
    };
    const setCheckKind = (k: CheckKind) => {
        if (k === 'record') setCheck({ kind: 'record', record: 'chat' });
        else if (k === 'keyword') setCheck({ kind: 'keyword', words: [], both: true });
        else if (k === 'ai') setCheck({ kind: 'ai', hint: '' });
        else setCheck({ kind: 'manual' });
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={existing ? '改約定' : '新增約定'} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                {wish && (
                    <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
                        <div className="text-[10.5px] tracking-wider text-[var(--bond-muted)]">從這個願望談來的</div>
                        <div className="bond-serif mt-1 text-[13.5px] leading-relaxed">{wish.text.slice(0, 120)}</div>
                    </div>
                )}
                {!existing && !wish && (
                    <section>
                        <SectionLabel>從 模 板 挑</SectionLabel>
                        <div className="flex flex-wrap gap-2">
                            {PROMISE_TEMPLATES.map(t => (
                                <button key={t.id} type="button" className="bond-chip" aria-pressed={templateId === t.id} onClick={() => applyTemplate(t.id)}>{templateTitle(t, space.bond.route)}</button>
                            ))}
                        </div>
                    </section>
                )}
                <section>
                    <SectionLabel>約 定</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[90px] leading-relaxed" value={text} onChange={e => { setText(e.target.value); setTemplateId(undefined); }}
                        placeholder="每天睡前說一聲晚安、每週通一次電話、明年夏天一起去看海……" />
                </section>
                <section>
                    <SectionLabel>多 久 一 次</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {REPEAT_KINDS.map(k => <button key={k.id} type="button" className="bond-chip" aria-pressed={repeat.kind === k.id} onClick={() => setRepeatKind(k.id)}>{k.label}</button>)}
                    </div>
                    {repeat.kind === 'weekly' && (
                        <div className="mt-3 flex flex-wrap gap-1.5">
                            {WEEKDAYS.map((d, i) => {
                                const on = (repeat.days || []).includes(i);
                                return <button key={d} type="button" className="bond-chip" aria-pressed={on}
                                    onClick={() => setRepeat({ kind: 'weekly', days: on ? (repeat.days || []).filter(x => x !== i) : [...(repeat.days || []), i].sort() })}>{d}</button>;
                            })}
                            <span className="self-center text-[11px] text-[var(--bond-muted)]">不選＝那週哪天都行</span>
                        </div>
                    )}
                    {repeat.kind === 'everyNDays' && (
                        <div className="mt-3 flex items-center gap-2 text-[12.5px]">每
                            <input type="number" min={2} max={60} className="bond-input text-center" style={{ width: 64, flex: 'none' }} value={repeat.n}
                                onChange={e => setRepeat({ kind: 'everyNDays', n: Math.max(2, Math.min(60, Math.round(Number(e.target.value) || 2))) })} />天
                        </div>
                    )}
                    {repeat.kind === 'yearly' && (
                        <div className="mt-3 flex items-center gap-2 text-[12.5px]">每年
                            <input type="date" className="bond-input" style={{ width: 160, flex: 'none' }} value={`2000-${repeat.date}`}
                                onChange={e => e.target.value && setRepeat({ kind: 'yearly', date: e.target.value.slice(5) })} />
                        </div>
                    )}
                </section>
                <section>
                    <SectionLabel>怎 麼 算 做 到</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {CHECK_KINDS.map(k => <button key={k.id} type="button" className="bond-chip" aria-pressed={check.kind === k.id} onClick={() => setCheckKind(k.id)}>{k.label}</button>)}
                    </div>
                    <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">{CHECK_KINDS.find(k => k.id === check.kind)?.hint}；判不到的你都可以手動記。</div>
                    {check.kind === 'record' && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {(Object.keys(RECORD_LABEL) as Array<keyof typeof RECORD_LABEL>).map(r => (
                                <button key={r} type="button" className="bond-chip" aria-pressed={check.record === r} onClick={() => setCheck({ kind: 'record', record: r })}>{RECORD_LABEL[r]}</button>
                            ))}
                        </div>
                    )}
                    {check.kind === 'keyword' && (
                        <div className="mt-3 space-y-2">
                            <input className="bond-input" value={check.words.join('、')} placeholder="用頓號或逗號隔開，例如：晚安、睡了"
                                onChange={e => setCheck({ kind: 'keyword', words: e.target.value.split(/[、,，]/).map(s => s.trim()).filter(Boolean), both: check.both })} />
                            <button type="button" className="bond-chip" aria-pressed={check.both} onClick={() => setCheck({ ...check, both: !check.both })}>{check.both ? '雙方都要說' : '一方說就算'}</button>
                        </div>
                    )}
                    {check.kind === 'ai' && (
                        <textarea className="bond-input mt-3 min-h-[70px]" value={check.hint} onChange={e => setCheck({ kind: 'ai', hint: e.target.value })}
                            placeholder="跟 AI 說怎樣算做到，例如：有好好聊到今天各自遇到的事" />
                    )}
                </section>
                <section>
                    <SectionLabel right={<button type="button" className="bond-chip" aria-pressed={scored} onClick={() => setScored(!scored)}>{scored ? '計分' : '不計分'}</button>}>積 分</SectionLabel>
                    {scored ? (
                        <div className="flex items-center gap-2 text-[12.5px]">每次做到
                            <input type="number" min={1} max={500} className="bond-input text-center" style={{ width: 72, flex: 'none' }} value={points}
                                onChange={e => setPoints(Math.max(1, Math.min(500, Math.round(Number(e.target.value) || 1))))} />分
                        </div>
                    ) : <p className="text-[11.5px] text-[var(--bond-muted)]">單純的約定，不算進羈絆等級。</p>}
                </section>
                {existing?.promise?.state === 'proposed' && <p className="text-[11px] text-[var(--bond-muted)]">還在商量的約定改了內容或頻率，等於重新提一次，{name}要再說好一次。</p>}
            </div>
            <Footer>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !text.trim()} onClick={save}><Handshake size={14} />{existing ? '存' : '提出約定'}</button>
            </Footer>
        </div>
    );
};

export const BondPromisePage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    entryId: string;
    onBack: () => void;
    onEdit: () => void;
    onOpenWish: (id: string) => void;
    onBringToChat?: (e: BondEntry) => void;
    addToast: Toast;
}> = ({ space, apiConfig, entryId, onBack, onEdit, onOpenWish, onBringToChat, addToast }) => {
    const entries = useBondEntries(space.id);
    const e = entries.find(x => x.id === entryId);
    const name = space.rightName;
    const [busy, setBusy] = useState(false);
    if (!e || !e.promise) return <Missing title="約定" onBack={onBack} what="個約定" />;
    const p = e.promise;
    const waiting = promiseWaitingOn(e);
    const wish = p.fromWishId ? entries.find(x => x.id === p.fromWishId) : undefined;

    const askTa = async () => {
        setBusy(true);
        try {
            const out = await charPromiseReply(space, apiConfig, e, wish?.text);
            const next = replyPromise(e, space.char.id, out.answer, out.words);
            await saveBondEntry(next);
            if (next.promise!.state === 'active') trackEvent('羁绊约定', { 动作: '成立', 来源: wish ? '愿望' : p.templateId ? '模板' : '自己写', 计分: p.points ? '是' : '否' });
        } catch (err: any) {
            addToast(err?.message || `${name}這次沒回`, 'error');
        } finally {
            setBusy(false);
        }
    };
    const agree = async () => {
        await saveBondEntry(agreePromise(e, 'user'));
        trackEvent('羁绊约定', { 动作: '成立', 来源: '角色提议', 计分: p.points ? '是' : '否' });
        addToast('說好了', 'success');
    };
    const setState = async (state: NonNullable<BondEntry['promise']>['state'], action: '暂停' | '结束' | '新增') => {
        await saveBondEntry(setPromiseState(e, state));
        if (action !== '新增') trackEvent('羁绊约定', { 动作: action, 来源: wish ? '愿望' : p.templateId ? '模板' : '自己写', 计分: p.points ? '是' : '否' });
        // 一次性的約定完成了：從願望談來的，願望也一起完成
        if (state === 'done' && wish && wish.wish?.state !== 'done') await saveBondEntry(setWishState(wish, 'done'));
    };

    const answerTag = p.reply ? ({ yes: '答應了', tweak: '想改一下', no: '先不要' } as const)[p.reply.answer] : '';

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="約定" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <article className="px-6 pt-7 pb-6 border-b bond-hair">
                    <div className="bond-note">{e.author === 'user' ? '你提的' : `${name}提的`} · {PROMISE_STATE_LABEL[p.state]}</div>
                    <div className="bond-serif mt-4 whitespace-pre-wrap text-[17px] leading-[1.9]">{e.text}</div>
                    <div className="mt-4 space-y-1 text-[12px] text-[var(--bond-ink-2)]">
                        <div>{repeatLabel(p.repeat)}{p.points ? ` · 每次 ${p.points} 分` : ' · 不計分'}</div>
                        <div className="text-[var(--bond-muted)]">{checkLabel(p.check)}</div>
                    </div>
                    {wish && <button type="button" className="mt-3 text-[11.5px] text-[var(--bond-accent)]" onClick={() => onOpenWish(wish.id)}>從願望「{wish.text.slice(0, 16)}」談來的</button>}
                </article>

                <div className="px-5 py-6 space-y-7">
                    {(waiting || p.reply || p.state === 'active') && (
                        <section>
                            <SectionLabel>說 好 了 嗎</SectionLabel>
                            {p.reply && <ReplyQuote who={p.reply.by === 'user' ? '你' : name} words={p.reply.words} tag={answerTag} />}
                            {waiting === 'char' && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button type="button" className="bond-btn" disabled={busy} onClick={askTa}><Sparkle size={14} />{busy ? `${name}在想…` : p.reply ? `再問 ${name} 一次` : `問問 ${name}`}</button>
                                    {p.reply && p.reply.answer !== 'yes' && <button type="button" className="bond-btn" onClick={onEdit}>改一改再問</button>}
                                    {onBringToChat && <button type="button" className="bond-btn" onClick={() => onBringToChat(e)}><ChatCircleText size={14} />去聊天裡談</button>}
                                </div>
                            )}
                            {waiting === 'user' && (
                                <div className="mt-3 flex flex-wrap gap-2">
                                    <button type="button" className="bond-btn bond-btn-primary" onClick={agree}><Handshake size={14} />好，說定了</button>
                                    <button type="button" className="bond-btn" onClick={() => setState('dropped', '结束')}>先不要</button>
                                </div>
                            )}
                            {!waiting && p.state === 'active' && <p className="mt-2 text-[11.5px] text-[var(--bond-muted)]">雙方都說好了，{name}會記得這個約定。</p>}
                        </section>
                    )}

                    {p.state !== 'proposed' && (
                        <section>
                            <SectionLabel>狀 態</SectionLabel>
                            <div className="flex flex-wrap gap-2">
                                {p.state === 'active' && <button type="button" className="bond-btn" onClick={() => setState('paused', '暂停')}>暫停</button>}
                                {p.state === 'paused' && <button type="button" className="bond-btn" onClick={() => setState('active', '新增')}>恢復</button>}
                                {p.state === 'active' && p.repeat.kind === 'once' && <button type="button" className="bond-btn" onClick={() => setState('done', '结束')}><Check size={14} />做到了</button>}
                                {(p.state === 'active' || p.state === 'paused') && <button type="button" className="bond-btn" onClick={() => setState('dropped', '结束')}>不做了</button>}
                                {(p.state === 'done' || p.state === 'dropped') && <button type="button" className="bond-btn" onClick={() => setState('active', '新增')}>重新開始</button>}
                            </div>
                        </section>
                    )}

                    {p.state !== 'proposed' && <PromiseProgress space={space} promise={e} addToast={addToast} />}

                    <section className="flex flex-wrap gap-2">
                        <button type="button" className="bond-btn" onClick={onEdit}>改內容</button>
                        {onBringToChat && waiting !== 'char' && <button type="button" className="bond-btn" onClick={() => onBringToChat(e)}><ChatCircleText size={14} />帶去聊聊</button>}
                    </section>

                    <DeleteRow label="刪掉這個約定" warn={`刪掉？${name}之後就不會記得${wish ? '（願望會回到「想做」）' : ''}。`}
                        onDelete={async () => {
                            if (wish && wish.wish?.promiseId === e.id) await saveBondEntry({ ...setWishState(wish, wish.wish.state === 'done' ? 'done' : 'want'), wish: { ...wish.wish, promiseId: undefined, state: wish.wish.state === 'done' ? 'done' : 'want' } });
                            await deleteBondEntries([e.id]);
                            trackEvent('羁绊约定', { 动作: '删除', 来源: wish ? '愿望' : p.templateId ? '模板' : '自己写', 计分: p.points ? '是' : '否' });
                            onBack();
                        }} />
                </div>
            </div>
        </div>
    );
};

/** 一個約定的進度（4.2）：這期做了沒、連續幾期、月曆、完成紀錄、補記 */
const PromiseProgress: React.FC<{ space: ResolvedSpace; promise: BondEntry; addToast: Toast }> = ({ space, promise, addToast }) => {
    const ledger = useBondLedger(space.id);
    const pr = promise.promise!;
    const key = ledgerKeyOf(promise);
    const today = dayKeyOf(Date.now());
    const start = promiseStartDay(promise) || undefined;
    const rows = useMemo(() => ledger.filter(r => r.key === key).sort((a, b) => b.periodKey.localeCompare(a.periodKey) || b.at - a.at), [ledger, key]);
    const once = pr.repeat.kind === 'once';
    const curKey = periodKeyOf(pr.repeat, today, start);
    const doneNow = !!donePeriod(ledger, key, curKey);
    const streak = streakOf(ledger, key, pr.repeat, today, start);
    const [month, setMonth] = useState(today.slice(0, 7));
    const [backDay, setBackDay] = useState(addDays(today, -1));
    const [shown, setShown] = useState(12);
    const record = async (day: string) => {
        if (start && day < start) { addToast(`約定是 ${start} 才說好的`, 'info'); return; }
        if (day > today) return;
        await recordManually(space, promise, day);
        addToast(pr.points ? `記下了 ＋${pr.points}` : '記下了', 'success');
    };
    const doneDays = new Set(rows.filter(isCounted).map(r => r.periodKey));
    const word = periodWord(pr.repeat) || '這次';
    return (
        <section>
            <SectionLabel>做 到 了 沒</SectionLabel>
            {pr.state === 'active' && (
                <div className="flex flex-wrap items-center gap-2">
                    {doneNow ? (
                        <span className="inline-flex items-center gap-1.5 text-[13px] text-[var(--bond-accent)]"><Check size={14} weight="bold" />{once ? '做到了' : `${word}做到了`}</span>
                    ) : (
                        <button type="button" className="bond-btn bond-btn-primary" disabled={!once && !countsOnDay(pr.repeat, today)} onClick={() => record(today)}>
                            <Check size={14} />{once ? '做到了，記一筆' : `${word}做到了，記一筆`}
                        </button>
                    )}
                    {!once && !countsOnDay(pr.repeat, today) && !doneNow && <span className="text-[11px] text-[var(--bond-muted)]">今天不是約好的日子</span>}
                </div>
            )}
            {!once && (
                <div className="mt-3 text-[12px] text-[var(--bond-ink-2)]">
                    {streak.current >= 1 ? `現在連續 ${streak.current} ${pr.repeat.kind === 'daily' ? '天' : '期'}` : '現在沒有連續'}{streak.best > streak.current ? `，最長 ${streak.best}` : ''}
                    <span className="text-[var(--bond-muted)]">（斷了只是重新數，已經加的分和經歷都留著）</span>
                </div>
            )}
            {pr.repeat.kind === 'daily' && (
                <MonthDots month={month} onMonth={setMonth} done={doneDays} start={start} today={today} />
            )}
            {!once && (
                <div className="mt-4 flex flex-wrap items-center gap-2 text-[12px]">
                    補記
                    <input type="date" className="bond-input" style={{ width: 160, flex: 'none' }} value={backDay} max={today} min={start}
                        onChange={ev => ev.target.value && setBackDay(ev.target.value)} />
                    <button type="button" className="bond-btn" onClick={() => record(backDay)}>那{pr.repeat.kind === 'daily' ? '天' : '期'}有做到</button>
                </div>
            )}
            {rows.length > 0 && (
                <div className="mt-4">
                    <div className="text-[10.5px] tracking-wider text-[var(--bond-muted)]">完成紀錄</div>
                    <div className="mt-1 divide-y bond-hair border-y">
                        {rows.slice(0, shown).map(r => <LedgerRowItem key={r.id} row={r} showLabel={false} />)}
                    </div>
                    {rows.length > shown && <button type="button" className="mt-2 text-[11.5px] text-[var(--bond-accent)]" onClick={() => setShown(n => n + 30)}>再看更早的</button>}
                </div>
            )}
        </section>
    );
};

/** 每天的約定：一個月的小月曆，做到的日子點上 */
const MonthDots: React.FC<{ month: string; onMonth: (m: string) => void; done: Set<string>; start?: string; today: string }> = ({ month, onMonth, done, start, today }) => {
    const [y, m] = month.split('-').map(Number);
    const first = `${month}-01`;
    const daysIn = new Date(y, m, 0).getDate();
    const lead = new Date(y, m - 1, 1).getDay();
    const shift = (n: number) => { const d = new Date(y, m - 1 + n, 1); onMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`); };
    return (
        <div className="mt-3 rounded-xl border bond-hair bg-[var(--bond-card)] px-3 py-3">
            <div className="flex items-center justify-between text-[12px]">
                <button type="button" className="px-2 text-[var(--bond-muted)]" onClick={() => shift(-1)} aria-label="上個月">‹</button>
                <span>{y} 年 {m} 月</span>
                <button type="button" className="px-2 text-[var(--bond-muted)] disabled:opacity-30" disabled={month >= today.slice(0, 7)} onClick={() => shift(1)} aria-label="下個月">›</button>
            </div>
            <div className="mt-2 grid grid-cols-7 gap-1 text-center text-[10px] text-[var(--bond-muted)]">
                {['日', '一', '二', '三', '四', '五', '六'].map(d => <span key={d}>{d}</span>)}
                {Array.from({ length: lead }, (_, i) => <span key={`l${i}`} />)}
                {Array.from({ length: daysIn }, (_, i) => {
                    const day = addDays(first, i);
                    const on = done.has(day);
                    const out = (start && day < start) || day > today;
                    return (
                        <span key={day} className={`mx-auto h-6 w-6 rounded-full grid place-items-center text-[10.5px] ${on ? 'bg-[var(--bond-accent)] text-white' : out ? 'opacity-30' : 'text-[var(--bond-ink-2)]'} ${day === today && !on ? 'border border-[var(--bond-accent)]' : ''}`}>{i + 1}</span>
                    );
                })}
            </div>
        </div>
    );
};

// ─── 默契 ─────────────────────────────────────────

export const BondHabitComposePage: React.FC<{
    space: ResolvedSpace;
    entryId?: string;
    onBack: () => void;
    onDone: (id: string) => void;
    addToast: Toast;
}> = ({ space, entryId, onBack, onDone, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const name = space.rightName;
    const [text, setText] = useState(existing?.text || '');
    const [origin, setOrigin] = useState<'agreed' | 'formed'>(existing?.habit?.origin || 'agreed');
    const [busy, setBusy] = useState(false);
    const save = async () => {
        if (!text.trim()) return;
        setBusy(true);
        try {
            const saved = await saveBondEntry(existing
                ? { ...existing, text: text.trim(), habit: { ...existing.habit!, origin }, updatedAt: Date.now() }
                : newHabit({ bondId: space.id, author: 'user', text, origin }));
            if (!existing) trackEvent('羁绊默契', { 动作: '提议', 谁: '我' });
            addToast(existing ? '改好了' : `寫好了，等${name}確認`, 'success');
            onDone(saved.id);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(false);
        }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={existing ? '改默契' : '寫一條默契'} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <section>
                    <SectionLabel>默 契</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[110px] leading-relaxed" value={text} onChange={e => setText(e.target.value)}
                        placeholder="一起聽歌時輪流選第一首、先到家的人傳一張窗外照片、只有我們懂的那個詞……" />
                </section>
                <section>
                    <SectionLabel>怎 麼 來 的</SectionLabel>
                    <div className="flex gap-2">
                        <button type="button" className="bond-chip" aria-pressed={origin === 'agreed'} onClick={() => setOrigin('agreed')}>說好的</button>
                        <button type="button" className="bond-chip" aria-pressed={origin === 'formed'} onClick={() => setOrigin('formed')}>慢慢就這樣了</button>
                    </div>
                    <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">只有你覺得的還不算默契；{name}認了才是。</div>
                </section>
            </div>
            <Footer>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !text.trim()} onClick={save}><Sparkle size={14} />{existing ? '存' : '寫好了'}</button>
            </Footer>
        </div>
    );
};

export const BondHabitPage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    entryId: string;
    onBack: () => void;
    onEdit: () => void;
    onBringToChat?: (e: BondEntry) => void;
    addToast: Toast;
}> = ({ space, apiConfig, entryId, onBack, onEdit, onBringToChat, addToast }) => {
    const entries = useBondEntries(space.id);
    const e = entries.find(x => x.id === entryId);
    const name = space.rightName;
    const [busy, setBusy] = useState(false);
    if (!e || !e.habit) return <Missing title="默契" onBack={onBack} what="條默契" />;
    const h = e.habit;
    const waiting = habitWaitingOn(e);

    const askTa = async () => {
        setBusy(true);
        try {
            const out = await charHabitReply(space, apiConfig, e);
            const next = replyHabit(e, space.char.id, out.answer, out.words);
            await saveBondEntry(next);
            if (next.habit!.state === 'active') trackEvent('羁绊默契', { 动作: '确认', 谁: '角色' });
        } catch (err: any) {
            addToast(err?.message || `${name}這次沒回`, 'error');
        } finally {
            setBusy(false);
        }
    };
    const confirm = async () => {
        await saveBondEntry(confirmHabit(e, 'user'));
        trackEvent('羁绊默契', { 动作: '确认', 谁: '我' });
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="默契" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <article className="px-6 pt-7 pb-6 border-b bond-hair">
                    <div className="bond-note">{e.author === 'user' ? '你寫的' : `${name}提的`} · {h.origin === 'agreed' ? '說好的' : '慢慢就這樣了'} · {HABIT_STATE_LABEL[h.state]}</div>
                    <div className="bond-serif mt-4 whitespace-pre-wrap text-[17px] leading-[1.9]">{e.text}</div>
                </article>
                <div className="px-5 py-6 space-y-7">
                    <section>
                        <SectionLabel>雙 方 確 認</SectionLabel>
                        {h.reply && <ReplyQuote who={h.reply.by === 'user' ? '你' : name} words={h.reply.words} tag={h.reply.answer === 'yes' ? '認了' : '不覺得'} />}
                        {waiting === 'char' && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                <button type="button" className="bond-btn" disabled={busy} onClick={askTa}><Sparkle size={14} />{busy ? `${name}在想…` : h.reply ? `再問 ${name} 一次` : `問問 ${name} 認不認`}</button>
                            </div>
                        )}
                        {waiting === 'user' && (
                            <div className="mt-3 flex flex-wrap gap-2">
                                <button type="button" className="bond-btn bond-btn-primary" onClick={confirm}><Check size={14} />對，是我們的默契</button>
                            </div>
                        )}
                        {h.state === 'active' && <p className="mt-2 text-[11.5px] text-[var(--bond-muted)]">你們都認了，{name}之後會照這樣跟你相處。</p>}
                    </section>
                    <section className="flex flex-wrap gap-2">
                        <button type="button" className="bond-btn" onClick={onEdit}>改一改</button>
                        {h.state !== 'proposed' && (
                            <button type="button" className="bond-btn" onClick={async () => {
                                await saveBondEntry(retireHabit(e, h.state !== 'retired'));
                                if (h.state !== 'retired') trackEvent('羁绊默契', { 动作: '不再', 谁: '我' });
                            }}>{h.state === 'retired' ? '其實還是這樣' : '不再這樣了'}</button>
                        )}
                        {onBringToChat && h.state === 'active' && <button type="button" className="bond-btn" onClick={() => onBringToChat(e)}><ChatCircleText size={14} />帶去聊聊</button>}
                    </section>
                    <DeleteRow label="刪掉這條" warn={`刪掉？${h.state === 'active' ? `${name}之後就不會記得。` : ''}`}
                        onDelete={async () => { await deleteBondEntries([e.id]); onBack(); }} />
                </div>
            </div>
        </div>
    );
};

// ─── 里程碑 ───────────────────────────────────────

export const BondMilestoneEditPage: React.FC<{
    space: ResolvedSpace;
    entryId?: string;
    onBack: () => void;
    onBringToChat?: (e: BondEntry) => void;
    addToast: Toast;
}> = ({ space, entryId, onBack, onBringToChat, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const name = space.rightName;
    const kinds = milestoneKindsFor(space.bond.route);
    const [what, setWhat] = useState(existing?.milestone?.what || kinds[0].id);
    const [title, setTitle] = useState(existing?.title || '');
    const [text, setText] = useState(existing?.text || '');
    const [day, setDay] = useState(existing?.eventDate.precision === 'day' ? existing.eventDate.date : getLocalDateKey(new Date()));
    const [unknownDay, setUnknownDay] = useState(existing ? existing.eventDate.precision === 'unknown' : false);
    const [anniversary, setAnniversary] = useState(false);
    const [busy, setBusy] = useState(false);

    const save = async () => {
        setBusy(true);
        try {
            const eventDate = unknownDay ? { precision: 'unknown' as const } : dayEventDate(day);
            const label = what === 'custom' ? title.trim() : '';
            let e: BondEntry = existing
                ? { ...existing, title: label || undefined, text: text.trim(), eventDate, milestone: { ...existing.milestone!, what }, updatedAt: Date.now() }
                : newMilestone({ bondId: space.id, author: 'user', what, title: label, text, eventDate, via: 'manual' });
            if (anniversary && !unknownDay && !e.milestone!.anniversaryId) {
                const ev = newEvent({
                    owner: personaParticipant(space.personaKey), kind: 'anniversary', title: `${milestoneLabel(what, label)}紀念日`, start: day, allDay: true,
                    participants: [charParticipant(space.char.id)], repeat: 'yearly', charRemembers: true, source: 'user',
                });
                await DB.saveCalendarEvent(ev);
                e = { ...e, milestone: { ...e.milestone!, anniversaryId: ev.id } };
            }
            await saveBondEntries([e]);
            addToast(existing ? '改好了' : '記下來了', 'success');
            onBack();
        } catch (err: any) {
            addToast(`沒存成功：${err?.message || err}`, 'error');
            setBusy(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={existing ? '里程碑' : '記一個里程碑'} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <section>
                    <SectionLabel>什 麼 事</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {kinds.map(k => <button key={k.id} type="button" className="bond-chip" aria-pressed={what === k.id} onClick={() => setWhat(k.id)}>{k.label}</button>)}
                    </div>
                    {what === 'custom' && <input className="bond-input mt-3" value={title} maxLength={30} placeholder="叫什麼" onChange={e => setTitle(e.target.value)} />}
                </section>
                <section>
                    <SectionLabel>哪 一 天</SectionLabel>
                    <div className="flex flex-wrap items-center gap-2">
                        {!unknownDay && <input type="date" className="bond-input" style={{ width: 170, flex: 'none' }} value={day} onChange={e => e.target.value && setDay(e.target.value)} />}
                        <button type="button" className="bond-chip" aria-pressed={unknownDay} onClick={() => setUnknownDay(!unknownDay)}>不記得是哪天</button>
                    </div>
                    {!unknownDay && !existing?.milestone?.anniversaryId && (
                        <button type="button" className="bond-chip mt-3" aria-pressed={anniversary} onClick={() => setAnniversary(!anniversary)}>同時記成紀念日（每年提醒，{name}也會記得）</button>
                    )}
                    {existing?.milestone?.anniversaryId && <p className="mt-2 text-[11px] text-[var(--bond-muted)]">已經記成紀念日了（在行事曆改）。</p>}
                </section>
                <section>
                    <SectionLabel>那 時 候</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[110px] leading-relaxed" value={text} onChange={e => setText(e.target.value)}
                        placeholder="在哪裡、怎麼發生的、誰先開口……只寫真的發生過的" />
                </section>
                {existing && existing.milestone?.via !== 'manual' && <p className="text-[11px] text-[var(--bond-muted)]">這個里程碑是{existing.milestone?.via === 'eventCard' ? '事件卡' : existing.milestone?.via === 'chat' ? '聊天' : '紀錄'}留下的。</p>}
                {existing && (
                    <DeleteRow label="刪掉這個里程碑" warn={`刪掉？${name}之後就不會記得。${existing.milestone?.anniversaryId ? '紀念日留在行事曆。' : ''}`}
                        onDelete={async () => { await deleteBondEntries([existing.id]); onBack(); }} />
                )}
            </div>
            <Footer>
                {existing && onBringToChat && <button type="button" className="bond-btn flex-1" onClick={() => onBringToChat(existing)}><ChatCircleText size={14} />帶去聊聊</button>}
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || (what === 'custom' && !title.trim())} onClick={save}><Flag size={14} />{existing ? '存' : '記下來'}</button>
            </Footer>
        </div>
    );
};
