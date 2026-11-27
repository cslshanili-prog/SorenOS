/**
 * 「心意」分頁（plans/bond-batch3.md 第 3 節，紀要 7.2）：日記、拾光問答、心靈角落。
 * 身份卡 × 角色的空間才有；角色之間的心意在第 6 批。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Feather, GearSix, Plus, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CharacterProfile, DiaryEntry } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import { charAsk } from './heartRun';
import { DB } from '../../utils/db';
import { personaBondId } from '../../utils/bond/model';
import { charPageUnread, diariesOfBond, diaryWriters, pageEmpty, pagePublished } from '../../utils/bond/diary';
import { answerQuestion, newQuestion, questionBucket, QUESTION_TOPIC_LABEL } from '../../utils/bond/question';
import { SLIP_STATE_LABEL, slipInbox, slipReplies, slipUnreadByUser } from '../../utils/bond/slip';
import { saveBondEntry } from '../../utils/bond/entries';
import { formatEventDate } from '../../utils/bond/eventDate';
import { trackEvent } from '../../utils/analytics';

export type HeartTab = 'diary' | 'question' | 'note';

/** 這個角色主線那張卡的空間（舊日記沒有 bondId 時算在這裡） */
export const mainBondIdOf = (space: ResolvedSpace) => personaBondId(space.char.id, space.char.primaryPersonaKey);

/** 這段關係的日記（跟著 DB 讀；回到這頁時重讀） */
export function useBondDiaries(space: ResolvedSpace): DiaryEntry[] | null {
    const [list, setList] = useState<DiaryEntry[] | null>(null);
    useEffect(() => {
        let alive = true;
        DB.getDiariesByCharId(space.char.id)
            .then(all => { if (alive) setList(diariesOfBond(all, space.id, mainBondIdOf(space))); })
            .catch(() => { if (alive) setList([]); });
        return () => { alive = false; };
    }, [space]);
    return list;
}

const dayText = (date: string) => formatEventDate({ precision: 'day', date });

/** 首頁「最近值得留意的一件事」（plans/bond-batch3.md 3.3，紀要 7.3 第 2 點）：只挑一則 */
export type HeartNotice =
    | { kind: 'slip'; id: string; label: string; text: string }
    | { kind: 'question'; id: string; label: string; text: string }
    | { kind: 'diary'; date: string; label: string; text: string };

const REVEAL_NOTICE_MS = 3 * 86400_000;

export function pickHeartNotice(input: { entries: BondEntry[]; diaries: DiaryEntry[]; name: string; now?: number }): HeartNotice | null {
    const { entries, diaries, name } = input;
    const now = input.now ?? Date.now();
    const slip = entries.filter(slipUnreadByUser).sort((a, b) => (b.slip?.deliveredAt || 0) - (a.slip?.deliveredAt || 0))[0];
    if (slip) return { kind: 'slip', id: slip.id, label: `${name}丟了一張紙條`, text: slip.text };
    const ask = entries.filter(e => e.kind === 'question' && questionBucket(e) === 'mine' && e.status === 'published').sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (ask) return { kind: 'question', id: ask.id, label: '等你回答', text: ask.question!.prompt };
    const diary = diaries.filter(charPageUnread).sort((a, b) => b.date.localeCompare(a.date))[0];
    if (diary) return { kind: 'diary', date: diary.date, label: `${name}寫了日記 · ${dayText(diary.date)}`, text: diary.charPage!.text };
    const revealed = entries
        .filter(e => e.kind === 'question' && e.question)
        .map(e => ({ e, at: e.question!.rounds[e.question!.rounds.length - 1].revealedAt || 0 }))
        .filter(x => x.at && now - x.at < REVEAL_NOTICE_MS && (x.e.seenAt || 0) < x.at)
        .sort((a, b) => b.at - a.at)[0];
    if (revealed) return { kind: 'question', id: revealed.e.id, label: '問答揭曉了', text: revealed.e.question!.prompt };
    return null;
}

export function useHeartNotice(space: ResolvedSpace): HeartNotice | null {
    const entries = useBondEntries(space.id);
    const diaries = useBondDiaries(space);
    return useMemo(() => (space.kind === 'persona' ? pickHeartNotice({ entries, diaries: diaries || [], name: space.rightName }) : null), [entries, diaries, space]);
}

export const BondHeartPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    tabBar: React.ReactNode;
    heart: HeartTab;
    onHeart: (t: HeartTab) => void;
    onBack: () => void;
    onOpenDiary: (date?: string) => void;
    onOpenQuestion: (id: string) => void;
    onNewQuestion: () => void;
    onOpenSlip: (id: string) => void;
    onNewSlip: () => void;
    /** 主動產出設定 */
    onOpenSettings: () => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, apiConfig, tabBar, heart, onHeart, onBack, onOpenDiary, onOpenQuestion, onNewQuestion, onOpenSlip, onNewSlip, onOpenSettings, addToast }) => {
    const entries = useBondEntries(space.id);
    const diaries = useBondDiaries(space);
    const name = space.rightName;
    const [asking, setAsking] = useState(false);

    const questions = useMemo(() => entries.filter(e => e.kind === 'question' && (e.status === 'published' || e.author === 'user'))
        .sort((a, b) => b.updatedAt - a.updatedAt), [entries]);
    const slips = useMemo(() => slipInbox(entries), [entries]);
    const dots = {
        diary: (diaries || []).some(charPageUnread),
        question: questions.some(q => questionBucket(q) === 'mine'),
        note: entries.some(slipUnreadByUser),
    };

    const askTa = async () => {
        setAsking(true);
        try {
            const out = await charAsk(space, apiConfig, entries);
            const q = answerQuestion(newQuestion({ bondId: space.id, openedBy: space.char.id, prompt: out.question, origin: 'char', topic: out.topic }), 'char', { text: out.answer, state: 'sealed' });
            await saveBondEntry(q);
            trackEvent('拾光问答', { 动作: '出题', 来源: '角色出' });
            onOpenQuestion(q.id);
        } catch (e: any) {
            addToast(e?.message || '這次沒出成題', 'error');
        } finally {
            setAsking(false);
        }
    };

    const SUBTABS: Array<{ id: HeartTab; label: string }> = [{ id: 'diary', label: '日記' }, { id: 'question', label: '問答' }, { id: 'note', label: '紙條' }];

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={name} onBack={onBack}
                right={<button type="button" onClick={onOpenSettings} aria-label="主動產出設定" className="h-9 w-9 grid place-items-center rounded-full text-[var(--bond-ink-2)] active:bg-[var(--bond-paper-2)]"><GearSix size={18} /></button>} />
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-5 pt-4 flex gap-2">
                    {SUBTABS.map(t => (
                        <button key={t.id} type="button" className="bond-chip relative" aria-pressed={heart === t.id} onClick={() => onHeart(t.id)}>
                            {t.label}
                            {dots[t.id] && <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--bond-accent)]" aria-label="有新的" />}
                        </button>
                    ))}
                </div>

                {heart === 'diary' && (
                    <div className="px-5 pt-4 pb-12">
                        <button type="button" onClick={() => onOpenDiary()}
                            className="w-full flex items-center justify-between rounded-[18px] bg-[var(--bond-block-mist)] px-4 py-3.5 text-left">
                            <span>
                                <span className="bond-serif block text-[14px]">寫今天的日記</span>
                                <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">誰先寫都行；你的那頁按「發布」{name}才看得到</span>
                            </span>
                            <Feather size={16} className="text-[var(--bond-accent)]" />
                        </button>
                        {diaries === null ? (
                            <p className="py-12 text-center text-[12.5px] text-[var(--bond-muted)]">讀取中…</p>
                        ) : diaries.length === 0 ? (
                            <p className="py-12 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">還沒有日記。以前在交換日記寫的也會出現在這裡。</p>
                        ) : (
                            <div className="mt-5 bond-panel px-4 divide-y bond-hair">
                                {diaries.map(d => {
                                    const w = diaryWriters(d);
                                    const preview = (d.charPage && !pageEmpty(d.charPage) ? d.charPage.text : d.userPage.text).replace(/\s+/g, ' ').slice(0, 60);
                                    return (
                                        <button key={d.id} type="button" onClick={() => onOpenDiary(d.date)} className="w-full text-left py-3.5 flex gap-4">
                                            <div className="w-14 shrink-0 pt-0.5 text-[11.5px] text-[var(--bond-muted)] tabular-nums leading-snug">{Number(d.date.slice(5, 7))}.{Number(d.date.slice(8, 10))}</div>
                                            <div className="min-w-0 flex-1">
                                                <div className="bond-serif text-[14px] leading-relaxed truncate">{preview || '（空白）'}</div>
                                                <div className="mt-1 flex items-center gap-2 text-[10.5px] tracking-wider text-[var(--bond-muted)]">
                                                    <span>{w === 'both' ? '你們都寫了' : w === 'user' ? '只有你寫了' : w === 'char' ? `${name} 先寫了` : '空白'}</span>
                                                    {!pageEmpty(d.userPage) && !pagePublished(d.userPage) && <span>· 你的是草稿</span>}
                                                    {charPageUnread(d) && <span className="text-[var(--bond-accent)]">· 新</span>}
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}

                {heart === 'question' && (
                    <div className="px-5 pt-4 pb-12">
                        <div className="flex gap-2">
                            <button type="button" onClick={onNewQuestion} className="flex-1 flex items-center justify-between rounded-[18px] bg-[var(--bond-block-mist)] px-4 py-3.5 text-left">
                                <span>
                                    <span className="bond-serif block text-[14px]">出一題</span>
                                    <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">自己想，或看推薦</span>
                                </span>
                                <Plus size={16} className="text-[var(--bond-accent)]" />
                            </button>
                            <button type="button" onClick={askTa} disabled={asking} className="flex-1 flex items-center justify-between rounded-[18px] bg-[var(--bond-block-mist)] px-4 py-3.5 text-left disabled:opacity-60">
                                <span>
                                    <span className="bond-serif block text-[14px]">{asking ? `${name}在想…` : `請 ${name} 出一題`}</span>
                                    <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">TA 先答、封存</span>
                                </span>
                                <Sparkle size={16} className="text-[var(--bond-accent)]" />
                            </button>
                        </div>
                        {questions.length === 0 ? (
                            <p className="py-12 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">還沒有問答。出題的人先答並封存，對方答完才一起揭曉。</p>
                        ) : (
                            (['mine', 'theirs', 'draft', 'revealed'] as const).map(bucket => {
                                const list = questions.filter(q => questionBucket(q) === bucket);
                                if (!list.length) return null;
                                const label = bucket === 'mine' ? '等 你 回 答' : bucket === 'theirs' ? `等 ${name} 回 答` : bucket === 'draft' ? '還 沒 送 出' : '已 揭 曉';
                                return (
                                    <section key={bucket} className="mt-6">
                                        <SectionLabel>{label}</SectionLabel>
                                        <div className="bond-panel px-4 divide-y bond-hair">
                                            {list.map(q => <QuestionRow key={q.id} q={q} name={name} onOpen={() => onOpenQuestion(q.id)} />)}
                                        </div>
                                    </section>
                                );
                            })
                        )}
                    </div>
                )}

                {heart === 'note' && (
                    <div className="px-5 pt-4 pb-12">
                        <button type="button" onClick={onNewSlip} className="w-full flex items-center justify-between rounded-[18px] bg-[var(--bond-block-mist)] px-4 py-3.5 text-left">
                            <span>
                                <span className="bond-serif block text-[14px]">寫一張紙條</span>
                                <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">投遞了{name}才知道；草稿只有你看得到</span>
                            </span>
                            <Feather size={16} className="text-[var(--bond-accent)]" />
                        </button>
                        {slips.length === 0 ? (
                            <p className="py-12 text-center text-[12.5px] leading-relaxed text-[var(--bond-muted)]">心靈角落還空著。吐槽、掛念、當面沒說出口的話，都可以丟進來。</p>
                        ) : (
                            <div className="mt-5 bond-panel px-4 divide-y bond-hair">
                                {slips.map(s => <SlipRow key={s.id} s={s} name={name} replies={slipReplies(entries, s.id).length} onOpen={() => onOpenSlip(s.id)} />)}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

const QuestionRow: React.FC<{ q: BondEntry; name: string; onOpen: () => void }> = ({ q, name, onOpen }) => {
    const rounds = q.question?.rounds.length || 0;
    return (
        <button type="button" onClick={onOpen} className="w-full text-left py-3.5">
            <div className="bond-serif text-[14px] leading-relaxed">{q.question?.prompt}</div>
            <div className="mt-1 flex items-center gap-2 text-[10.5px] tracking-wider text-[var(--bond-muted)]">
                <span>{q.author === 'user' ? '你出的' : `${name}出的`}</span>
                {q.question?.topic && q.question.topic !== 'custom' && <span>· {QUESTION_TOPIC_LABEL[q.question.topic]}</span>}
                {rounds > 1 && <span>· 第 {rounds} 次</span>}
            </div>
        </button>
    );
};

const SlipRow: React.FC<{ s: BondEntry; name: string; replies: number; onOpen: () => void }> = ({ s, name, replies, onOpen }) => {
    const unread = slipUnreadByUser(s);
    return (
        <button type="button" onClick={onOpen} className="w-full text-left py-3.5">
            <div className="flex items-center gap-2 text-[10.5px] tracking-wider text-[var(--bond-muted)]">
                <span>{s.author === 'user' ? '你丟的' : `${name}丟的`}</span>
                {s.status === 'draft' && <span>· 草稿</span>}
                {(s.slip?.tags || []).slice(0, 2).map(t => <span key={t}>· {t}</span>)}
                {unread && <span className="text-[var(--bond-accent)]">· 新</span>}
            </div>
            <div className={`bond-serif mt-1 text-[14px] leading-relaxed ${unread ? '' : 'text-[var(--bond-ink-2)]'}`}>{s.text.replace(/\s+/g, ' ').slice(0, 80)}</div>
            {(replies > 0 || s.slip?.state) && (
                <div className="mt-1 text-[10.5px] text-[var(--bond-muted)]">
                    {replies > 0 ? `回應 ${replies}` : ''}{replies > 0 && s.slip?.state ? ' · ' : ''}{s.slip?.state ? SLIP_STATE_LABEL[s.slip.state] : ''}
                </div>
            )}
        </button>
    );
};
