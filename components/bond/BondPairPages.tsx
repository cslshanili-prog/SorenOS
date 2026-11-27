/**
 * 角色之間的心意、約定、珍藏（plans/bond-batch6.md 第 3 節）。全部全螢幕。
 * 共同原則：只呈現結果＋小按鈕；你能改字、能刪，不能用自己的名義新增（作者是他們）；里程碑例外，可以手動補。
 * 沒有等級積點、親近信任、心靈角落、留給以後；信沒有慢寄（寄出就到）。小按鈕跑在 pairRun.ts。
 */
import React, { useEffect, useMemo, useState } from 'react';
import { ArrowsClockwise, Envelope as EnvelopeIcon, Feather, Gift, NotePencil, Plus, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { BondHeader, SectionLabel } from './bondUi';
import { useBondEntries } from './useSpaceTimeline';
import { askPairQuestion, pairLetter, pairWish, suggestPairQuestions, writePairDiary } from './pairRun';
import { GiftBox } from './treasure/GiftBox';
import { Envelope, type EnvelopeStage } from './treasure/Envelope';
import ExpandableTextarea from '../common/ExpandableTextarea';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { formatEventDate } from '../../utils/bond/eventDate';
import { HABIT_STATE_LABEL, PROMISE_STATE_LABEL, milestoneLabel, repeatLabel } from '../../utils/bond/pact';
import { giftWrapFor } from '../../utils/bond/gift';
import { letterRoot, waxFor } from '../../utils/bond/letter';
import { lastRound, startNewRound } from '../../utils/bond/question';
import { pairAnswerOf } from '../../utils/bond/pairPrompt';
import { chapterLabel } from '../../utils/bond/story';
import { QUESTION_TOPIC_LABEL } from '../../utils/bond/question';
import type { StorySide } from '../../utils/bond/storyExtract';
import type { BondQuestionTopic } from '../../types';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const Footer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>{children}</div>
);

const DeleteRow: React.FC<{ label: string; warn: string; onDelete: () => void }> = ({ label, warn, onDelete }) => {
    const [ask, setAsk] = useState(false);
    return !ask ? (
        <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4" onClick={() => setAsk(true)}>{label}</button>
    ) : (
        <div className="flex flex-wrap items-center gap-2 text-[12.5px]" ref={n => n?.scrollIntoView({ block: 'nearest' })}>
            <span>{warn}</span>
            <button type="button" className="bond-btn" onClick={() => setAsk(false)}>先不要</button>
            <button type="button" className="bond-btn bond-btn-primary" onClick={onDelete}>刪掉</button>
        </div>
    );
};

const Paragraphs: React.FC<{ text: string; className?: string }> = ({ text, className }) => (
    <div className={`bond-serif text-[15px] leading-[1.9] space-y-3 ${className || ''}`}>
        {text.split(/\n{2,}/).map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
    </div>
);

/** 你改字：第一次改留原文（角色記得的是改過的版本） */
const withEditedText = (e: BondEntry, text: string): BondEntry => {
    const t = text.trim();
    if (t === e.text) return e;
    const now = Date.now();
    return { ...e, text: t, ...(e.originalText === undefined ? { originalText: e.text } : {}), revisedAt: now, updatedAt: now };
};

/** 這段關係的兩個人，照 A／B */
const sidesOf = (space: ResolvedSpace): Array<{ side: StorySide; char: CharacterProfile }> =>
    space.other ? [{ side: 'a', char: space.char }, { side: 'b', char: space.other }] : [];
const nameOfId = (space: ResolvedSpace, id: string) => (id === space.char.id ? space.char.name : id === space.other?.id ? space.other.name : id === 'user' ? '你' : '某人');
const sideOfId = (space: ResolvedSpace, id: string): StorySide => (id === space.char.id ? 'a' : 'b');

/** 小按鈕：轉著等 AI */
const SmallBtn: React.FC<{ busy: boolean; onClick: () => void; children: React.ReactNode }> = ({ busy, onClick, children }) => (
    <button type="button" className="bond-btn text-[12.5px]" disabled={busy} onClick={onClick}>
        {busy ? <ArrowsClockwise size={13} className="animate-spin" /> : <Sparkle size={13} />}{children}
    </button>
);

// ─── 心意：日記、問答 ───────────────────────────────

export type PairHeartTab = 'diary' | 'question';

export const PairHeartPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    header: React.ReactNode;
    tabBar: React.ReactNode;
    sub: PairHeartTab;
    onSub: (t: PairHeartTab) => void;
    onOpenDiary: (id: string) => void;
    onOpenQuestion: (id: string) => void;
    onNewQuestion: () => void;
    addToast: Toast;
}> = ({ space, characters, apiConfig, header, tabBar, sub, onSub, onOpenDiary, onOpenQuestion, onNewQuestion, addToast }) => {
    const entries = useBondEntries(space.id);
    const [busy, setBusy] = useState<string | null>(null);
    const diaries = useMemo(() => entries.filter(e => e.kind === 'diary' && e.status === 'published')
        .sort((x, y) => (y.diary?.date || '').localeCompare(x.diary?.date || '') || y.writtenAt - x.writtenAt), [entries]);
    const questions = useMemo(() => entries.filter(e => e.kind === 'question').sort((x, y) => y.updatedAt - x.updatedAt), [entries]);

    const write = async (side: StorySide) => {
        setBusy(`diary-${side}`);
        try {
            const e = await writePairDiary(space, side, characters, entries, apiConfig);
            onOpenDiary(e.id);
        } catch (err: any) {
            addToast(err?.message || '這次沒寫成', 'error');
        } finally {
            setBusy(null);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            {header}
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-5 pt-4 flex gap-2">
                    {([['diary', '日記'], ['question', '問答']] as const).map(([id, label]) => (
                        <button key={id} type="button" className="bond-chip relative" aria-pressed={sub === id} onClick={() => onSub(id)}>
                            {label}
                            {id === 'question' && questions.some(q => !q.seenAt && !!lastRound(q.question)?.revealedAt) && (
                                <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[var(--bond-accent)]" aria-label="有新的" />
                            )}
                        </button>
                    ))}
                </div>
                {sub === 'diary' ? (
                    <div className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                            {sidesOf(space).map(({ side, char }) => (
                                <SmallBtn key={side} busy={busy === `diary-${side}`} onClick={() => void write(side)}>讓{char.name}寫一篇</SmallBtn>
                            ))}
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-[var(--bond-muted)]">只寫最近發生的（最近一章、私下聊的、最近的片刻）；日記只有寫的人自己知道。</p>
                        {diaries.length === 0 ? (
                            <div className="mt-10 text-center text-[13px] text-[var(--bond-muted)]">還沒有日記。</div>
                        ) : (
                            <div className="mt-4 divide-y bond-hair border-y">
                                {diaries.map(e => (
                                    <button key={e.id} type="button" className="w-full text-left py-3.5" onClick={() => onOpenDiary(e.id)}>
                                        <div className="flex items-center gap-2 text-[11px] text-[var(--bond-muted)]">
                                            <span className="text-[var(--bond-accent)]">{nameOfId(space, e.author)}</span>
                                            <span>{e.diary?.date ? formatEventDate({ precision: 'day', date: e.diary.date }) : formatEventDate(e.eventDate)}</span>
                                            {e.diary?.origin === 'story' && <span>・故事之後</span>}
                                            {e.diary?.origin === 'auto' && <span>・私下聊完</span>}
                                        </div>
                                        <div className="mt-1 bond-serif text-[13.5px] leading-relaxed line-clamp-2">{e.text}</div>
                                    </button>
                                ))}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="px-5 py-4">
                        <button type="button" className="bond-btn" onClick={onNewQuestion}><Plus size={14} />讓他們回答一題</button>
                        <p className="mt-2 text-[11px] leading-relaxed text-[var(--bond-muted)]">兩人各自作答、看不到對方的答案，答完一起揭曉。</p>
                        {questions.length === 0 ? (
                            <div className="mt-10 text-center text-[13px] text-[var(--bond-muted)]">還沒問過他們。</div>
                        ) : (
                            <div className="mt-4 divide-y bond-hair border-y">
                                {questions.map(q => {
                                    const fresh = !q.seenAt && !!lastRound(q.question)?.revealedAt;
                                    return (
                                        <button key={q.id} type="button" className="w-full text-left py-3.5 flex items-start gap-3" onClick={() => onOpenQuestion(q.id)}>
                                            <span className="min-w-0 flex-1">
                                                <span className="block bond-serif text-[14px] leading-relaxed">{q.text}</span>
                                                <span className="block mt-0.5 text-[11px] text-[var(--bond-muted)]">
                                                    {(q.question?.rounds.length || 0) > 1 ? `答了 ${q.question!.rounds.length} 次・` : ''}{fresh ? '答好了，等你揭曉' : '揭曉過了'}
                                                </span>
                                            </span>
                                            {fresh && <span className="mt-2 h-2 w-2 shrink-0 rounded-full bg-[var(--bond-accent)]" aria-label="有新的" />}
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
};

/** 一篇日記：閱讀排版，能改字、能刪 */
export const PairDiaryPage: React.FC<{ space: ResolvedSpace; entryId: string; onBack: () => void; addToast: Toast }> = ({ space, entryId, onBack, addToast }) => {
    const entries = useBondEntries(space.id);
    const entry = entries.find(e => e.id === entryId) || bondEntryById(entryId);
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(entry?.text || '');
    const [showOriginal, setShowOriginal] = useState(false);
    if (!entry) return <Gone title="日記" onBack={onBack} />;
    const author = nameOfId(space, entry.author);
    const save = async () => {
        await saveBondEntry(withEditedText(entry, text));
        setEditing(false);
        addToast('改好了', 'success');
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={`${author}的日記`} onBack={onBack}
                right={!editing ? <button type="button" className="bond-note px-2 py-1" onClick={() => { setText(entry.text); setEditing(true); }}>改</button> : undefined} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-6 py-6">
                <div className="mb-5 text-center text-[11px] text-[var(--bond-muted)]">
                    {entry.diary?.date ? formatEventDate({ precision: 'day', date: entry.diary.date }) : formatEventDate(entry.eventDate)}・只有{author}自己知道
                </div>
                {editing
                    ? <textarea className="bond-input bond-serif min-h-[55vh] text-[15px] leading-[1.9]" value={text} onChange={e => setText(e.target.value)} />
                    : <Paragraphs text={showOriginal && entry.originalText ? entry.originalText : entry.text} />}
                {!editing && entry.originalText !== undefined && (
                    <button type="button" className="mt-6 text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4" onClick={() => setShowOriginal(v => !v)}>
                        {showOriginal ? '看改過的' : `你改過字（${author}記得的是改過的），看原本的`}
                    </button>
                )}
                {!editing && <div className="mt-10"><DeleteRow label="刪掉這篇" warn={`刪掉？${author}之後就不記得寫過。`} onDelete={async () => { await deleteBondEntries([entry.id]); onBack(); }} /></div>}
            </div>
            {editing && (
                <Footer>
                    <button type="button" className="bond-btn flex-1" onClick={() => setEditing(false)}>不改了</button>
                    <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!text.trim()} onClick={() => void save()}>存</button>
                </Footer>
            )}
        </div>
    );
};

const Gone: React.FC<{ title: string; onBack: () => void }> = ({ title, onBack }) => (
    <div className="absolute inset-0 flex flex-col bond-root">
        <BondHeader title={title} onBack={onBack} />
        <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">已經不在了。</div>
    </div>
);

/** 讓他們回答一題：你出題，或 AI 推薦三題選一題 */
export const PairQuestionNewPage: React.FC<{
    space: ResolvedSpace; characters: CharacterProfile[]; apiConfig: APIConfig; onBack: () => void; onDone: (id: string) => void; addToast: Toast;
}> = ({ space, characters, apiConfig, onBack, onDone, addToast }) => {
    const entries = useBondEntries(space.id);
    const [prompt, setPrompt] = useState('');
    const [picked, setPicked] = useState<{ prompt: string; topic: BondQuestionTopic } | null>(null);
    const [suggestions, setSuggestions] = useState<Array<{ prompt: string; topic: BondQuestionTopic }>>([]);
    const [busy, setBusy] = useState<'suggest' | 'ask' | null>(null);
    const suggest = async () => {
        setBusy('suggest');
        try { setSuggestions(await suggestPairQuestions(space, characters, entries, apiConfig)); } catch (e: any) { addToast(e?.message || '這次沒推薦出來', 'error'); } finally { setBusy(null); }
    };
    const ask = async () => {
        const text = prompt.trim();
        if (!text) return;
        setBusy('ask');
        try {
            const fromSuggest = picked && picked.prompt === text;
            const e = await askPairQuestion(space, characters, entries, apiConfig, { prompt: text, origin: fromSuggest ? 'ai_suggest' : 'user', ...(fromSuggest ? { topic: picked!.topic } : {}) });
            onDone(e.id);
        } catch (err: any) {
            addToast(err?.message || '這次沒答成', 'error');
            setBusy(null);
        }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="讓他們回答一題" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <section>
                    <SectionLabel>題 目</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[90px] leading-relaxed" value={prompt} maxLength={200}
                        placeholder={`想問${space.leftName}和${space.rightName}什麼？`} onChange={e => { setPrompt(e.target.value); if (picked && e.target.value !== picked.prompt) setPicked(null); }} />
                </section>
                <section>
                    <SmallBtn busy={busy === 'suggest'} onClick={() => void suggest()}>照他們的關係推薦三題</SmallBtn>
                    {suggestions.length > 0 && (
                        <div className="mt-3 space-y-2">
                            {suggestions.map((s, i) => (
                                <button key={i} type="button" aria-pressed={picked?.prompt === s.prompt} onClick={() => { setPicked(s); setPrompt(s.prompt); }}
                                    className={`w-full text-left rounded-xl border px-3.5 py-3 ${picked?.prompt === s.prompt ? 'border-[var(--bond-accent)]' : 'border-[var(--bond-line)]'}`}>
                                    <span className="block text-[10.5px] text-[var(--bond-muted)]">{QUESTION_TOPIC_LABEL[s.topic]}</span>
                                    <span className="block mt-0.5 bond-serif text-[14px] leading-relaxed">{s.prompt}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
                <p className="text-[11.5px] leading-relaxed text-[var(--bond-muted)]">兩人會各自作答，互相看不到；答好了等你揭曉。</p>
            </div>
            <Footer>
                <button type="button" className="bond-btn bond-btn-primary w-full" disabled={!prompt.trim() || !!busy} onClick={() => void ask()}>
                    {busy === 'ask' ? '他們在各自作答…' : '讓他們答'}
                </button>
            </Footer>
        </div>
    );
};

/** 一題：揭曉是給你看的演出（你點了才翻開） */
export const PairQuestionPage: React.FC<{
    space: ResolvedSpace; characters: CharacterProfile[]; apiConfig: APIConfig; entryId: string; onBack: () => void; addToast: Toast;
}> = ({ space, characters, apiConfig, entryId, onBack, addToast }) => {
    const entries = useBondEntries(space.id);
    const entry = entries.find(e => e.id === entryId) || bondEntryById(entryId);
    const [flipping, setFlipping] = useState(false);
    const [busy, setBusy] = useState(false);
    if (!entry?.question) return <Gone title="問答" onBack={onBack} />;
    const rounds = entry.question.rounds.filter(r => r.revealedAt);
    const revealedForYou = !!entry.seenAt;
    const reveal = async () => {
        setFlipping(true);
        window.setTimeout(() => { void saveBondEntry({ ...entry, seenAt: Date.now() }); }, 650);
    };
    const again = async () => {
        setBusy(true);
        try {
            await askPairQuestion(space, characters, entries, apiConfig, { prompt: entry.text, origin: entry.question!.origin === 'char' ? 'user' : entry.question!.origin as 'user' | 'ai_suggest', existing: startNewRound(entry, 'user') });
        } catch (e: any) {
            addToast(e?.message || '這次沒答成', 'error');
        } finally {
            setBusy(false);
        }
    };
    const last = rounds.at(-1);
    const older = rounds.slice(0, -1);
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="問答" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6">
                <div className="text-center">
                    {entry.question.topic && <div className="text-[10.5px] text-[var(--bond-muted)]">{QUESTION_TOPIC_LABEL[entry.question.topic]}</div>}
                    <h2 className="mt-1 bond-serif text-[18px] leading-relaxed">{entry.text}</h2>
                </div>
                {last && (
                    <div className="mt-6 grid grid-cols-2 gap-3">
                        {sidesOf(space).map(({ side, char }) => {
                            const a = pairAnswerOf(last, side);
                            const open = revealedForYou || flipping;
                            return (
                                <div key={side} className="rounded-xl border border-[var(--bond-line)] bg-[var(--bond-card)] px-3.5 py-3 min-h-[120px]"
                                    style={{ transition: 'transform .6s ease, opacity .6s ease', transform: open ? 'rotateY(0deg)' : 'rotateY(8deg)' }}>
                                    <div className="text-[11px] text-[var(--bond-accent)]">{char.name}</div>
                                    {open ? (
                                        <div className="mt-1.5 bond-serif text-[13.5px] leading-relaxed whitespace-pre-wrap">{a?.state === 'skipped' || !a?.text ? '（沒答）' : a.text}</div>
                                    ) : (
                                        <div className="mt-6 text-center text-[12px] text-[var(--bond-muted)]">封著</div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
                {!revealedForYou && !flipping && last && (
                    <div className="mt-6 text-center">
                        <button type="button" className="bond-btn bond-btn-primary" onClick={() => void reveal()}>揭曉</button>
                    </div>
                )}
                {older.length > 0 && (revealedForYou || flipping) && (
                    <section className="mt-8">
                        <SectionLabel>之 前 答 的</SectionLabel>
                        {older.map((r, i) => (
                            <div key={i} className="mt-3 text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">
                                {sidesOf(space).map(({ side, char }) => <div key={side}><span className="text-[var(--bond-muted)]">{char.name}：</span>{pairAnswerOf(r, side)?.text || '（沒答）'}</div>)}
                            </div>
                        ))}
                    </section>
                )}
                {(revealedForYou || flipping) && (
                    <div className="mt-10 flex flex-wrap items-center gap-3">
                        <SmallBtn busy={busy} onClick={() => void again()}>再讓他們答一次</SmallBtn>
                        <DeleteRow label="刪掉這題" warn="刪掉？他們之後就不記得答過。" onDelete={async () => { await deleteBondEntries([entry.id]); onBack(); }} />
                    </div>
                )}
            </div>
        </div>
    );
};

// ─── 約定：願望、約定、默契、里程碑 ───────────────────

export const PairPactPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    header: React.ReactNode;
    tabBar: React.ReactNode;
    onOpenEntry: (id: string) => void;
    onOpenMilestone: (id?: string) => void;
    addToast: Toast;
}> = ({ space, characters, apiConfig, header, tabBar, onOpenEntry, onOpenMilestone, addToast }) => {
    const entries = useBondEntries(space.id);
    const [busy, setBusy] = useState<string | null>(null);
    const pub = entries.filter(e => e.status === 'published');
    const wishes = pub.filter(e => e.kind === 'wish' && e.wish).sort((x, y) => y.writtenAt - x.writtenAt);
    const promises = pub.filter(e => e.kind === 'promise' && e.promise).sort((x, y) => y.writtenAt - x.writtenAt);
    const habits = pub.filter(e => e.kind === 'habit' && e.habit).sort((x, y) => y.writtenAt - x.writtenAt);
    const milestones = pub.filter(e => e.kind === 'milestone' && e.milestone)
        .sort((x, y) => (y.eventDate.precision === 'day' ? y.eventDate.date : '').localeCompare(x.eventDate.precision === 'day' ? x.eventDate.date : '') || y.writtenAt - x.writtenAt);
    const wish = async (side: StorySide) => {
        setBusy(side);
        try { await pairWish(space, side, characters, entries, apiConfig); addToast('記下了一個願望', 'success'); } catch (e: any) { addToast(e?.message || '這次沒說出來', 'error'); } finally { setBusy(null); }
    };
    const fromStory = (e: BondEntry) => e.sources.some(s => s.type === 'story');
    const row = (e: BondEntry, head: string, onClick: () => void) => (
        <button key={e.id} type="button" className="w-full text-left py-3.5" onClick={onClick}>
            <div className="text-[11px] text-[var(--bond-muted)]">{head}{fromStory(e) ? '・故事裡' : ''}</div>
            <div className="mt-0.5 text-[13.5px] leading-relaxed">{e.text || (e.milestone ? milestoneLabel(e.milestone.what, e.title) : '')}</div>
        </button>
    );
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            {header}
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4 space-y-7">
                <p className="text-[11.5px] leading-relaxed text-[var(--bond-muted)]">都是他們之間已經說出口、說好的事（多半從故事裡來）；這裡只呈現，沒有完成判定、沒有積點。你能改字、能刪。</p>
                <section>
                    <SectionLabel>願 望</SectionLabel>
                    <div className="flex flex-wrap gap-2 mb-2">
                        {sidesOf(space).map(({ side, char }) => <SmallBtn key={side} busy={busy === side} onClick={() => void wish(side)}>讓{char.name}說一個願望</SmallBtn>)}
                    </div>
                    {wishes.length ? <div className="divide-y bond-hair border-y">{wishes.map(e => row(e, e.wish!.owner === 'both' ? '他們兩人的' : `${nameOfId(space, e.wish!.owner)}的`, () => onOpenEntry(e.id)))}</div>
                        : <Empty>還沒有願望。</Empty>}
                </section>
                <section>
                    <SectionLabel>約 定</SectionLabel>
                    {promises.length ? <div className="divide-y bond-hair border-y">{promises.map(e => row(e, `${repeatLabel(e.promise!.repeat)}・${PROMISE_STATE_LABEL[e.promise!.state]}`, () => onOpenEntry(e.id)))}</div>
                        : <Empty>還沒有說好的約定。</Empty>}
                </section>
                <section>
                    <SectionLabel>默 契</SectionLabel>
                    {habits.length ? <div className="divide-y bond-hair border-y">{habits.map(e => row(e, e.habit!.state === 'active' ? '他們的默契' : HABIT_STATE_LABEL[e.habit!.state], () => onOpenEntry(e.id)))}</div>
                        : <Empty>還沒有默契。</Empty>}
                </section>
                <section>
                    <SectionLabel>里 程 碑</SectionLabel>
                    <button type="button" className="bond-btn text-[12.5px] mb-2" onClick={() => onOpenMilestone()}><Plus size={13} />補一個里程碑</button>
                    {milestones.length ? <div className="divide-y bond-hair border-y">{milestones.map(e => row(e, `${milestoneLabel(e.milestone!.what, e.title)}・${formatEventDate(e.eventDate)}`, () => onOpenMilestone(e.id)))}</div>
                        : <Empty>還沒有里程碑。</Empty>}
                </section>
            </div>
        </div>
    );
};

const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <div className="py-3 text-[12.5px] text-[var(--bond-muted)]">{children}</div>;

const PACT_TITLE: Record<string, string> = { wish: '願望', promise: '約定', habit: '默契' };

/** 願望、約定、默契：改字、刪 */
export const PairPactEditPage: React.FC<{ space: ResolvedSpace; entryId: string; onBack: () => void; addToast: Toast }> = ({ space, entryId, onBack, addToast }) => {
    const entry = bondEntryById(entryId);
    const [text, setText] = useState(entry?.text || '');
    if (!entry) return <Gone title="約定" onBack={onBack} />;
    const save = async () => { await saveBondEntry(withEditedText(entry, text)); addToast('改好了', 'success'); onBack(); };
    const who = entry.kind === 'wish' ? (entry.wish!.owner === 'both' ? '他們兩人的願望' : `${nameOfId(space, entry.wish!.owner)}的願望`)
        : entry.kind === 'promise' ? `${repeatLabel(entry.promise!.repeat)}的約定` : '他們的默契';
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={PACT_TITLE[entry.kind] || '約定'} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-5">
                <div className="text-[11.5px] text-[var(--bond-muted)]">{who}{entry.sources.some(s => s.type === 'story') ? '・從故事裡來' : ''}</div>
                <textarea className="bond-input bond-serif min-h-[110px] leading-relaxed" value={text} onChange={e => setText(e.target.value)} />
                {entry.originalText !== undefined && <p className="text-[11px] text-[var(--bond-muted)]">原本是：{entry.originalText}</p>}
                <DeleteRow label={`刪掉這個${PACT_TITLE[entry.kind] || ''}`} warn="刪掉？他們之後就不記得。" onDelete={async () => { await deleteBondEntries([entry.id]); onBack(); }} />
            </div>
            <Footer><button type="button" className="bond-btn bond-btn-primary w-full" disabled={!text.trim()} onClick={() => void save()}>存</button></Footer>
        </div>
    );
};

// ─── 珍藏：禮物、信 ─────────────────────────────────

export type PairTreasureTab = 'gift' | 'letter';

export const PairTreasurePage: React.FC<{
    space: ResolvedSpace;
    header: React.ReactNode;
    tabBar: React.ReactNode;
    sub: PairTreasureTab;
    onSub: (t: PairTreasureTab) => void;
    onOpenGift: (id: string) => void;
    onOpenLetter: (id: string) => void;
    onWriteLetter: (from: StorySide) => void;
}> = ({ space, header, tabBar, sub, onSub, onOpenGift, onOpenLetter, onWriteLetter }) => {
    const entries = useBondEntries(space.id);
    const gifts = entries.filter(e => e.kind === 'gift' && e.gift && e.status === 'published').sort((x, y) => y.writtenAt - x.writtenAt);
    const letters = entries.filter(e => e.kind === 'letter' && e.letter && e.status === 'published').sort((x, y) => (y.letter!.sentAt || y.writtenAt) - (x.letter!.sentAt || x.writtenAt));
    const giver = (e: BondEntry) => (e.gift!.dir === 'out' ? space.char : space.other!);
    const receiver = (e: BondEntry) => (e.gift!.dir === 'out' ? space.other! : space.char);
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            {header}
            {tabBar}
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-5 pt-4 flex gap-2">
                    <button type="button" className="bond-chip" aria-pressed={sub === 'gift'} onClick={() => onSub('gift')}><Gift size={13} />禮物</button>
                    <button type="button" className="bond-chip" aria-pressed={sub === 'letter'} onClick={() => onSub('letter')}><EnvelopeIcon size={13} />信件</button>
                </div>
                {sub === 'gift' ? (
                    <div className="px-5 py-4">
                        <p className="text-[11px] leading-relaxed text-[var(--bond-muted)]">他們之間送過的東西（從故事裡記下來的）。</p>
                        {gifts.length === 0 ? <div className="mt-10 text-center text-[13px] text-[var(--bond-muted)]">還沒有禮物。</div> : (
                            <div className="mt-4 grid grid-cols-3 gap-x-3 gap-y-5">
                                {gifts.map(e => {
                                    const look = giftWrapFor(e.id);
                                    return (
                                        <button key={e.id} type="button" className="flex flex-col items-center text-center" onClick={() => onOpenGift(e.id)}>
                                            <GiftBox wrap={look.wrap} ribbon={look.ribbon} size={78} />
                                            <span className="mt-1.5 text-[12px] leading-snug line-clamp-2">{e.title || e.text}</span>
                                            <span className="text-[10.5px] text-[var(--bond-muted)]">{giver(e).name} → {receiver(e).name}</span>
                                        </button>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                ) : (
                    <div className="px-5 py-4">
                        <div className="flex flex-wrap gap-2">
                            {sidesOf(space).map(({ side, char }) => (
                                <button key={side} type="button" className="bond-btn text-[12.5px]" onClick={() => onWriteLetter(side)}>
                                    <Feather size={13} />讓{char.name}寫一封信
                                </button>
                            ))}
                        </div>
                        <p className="mt-2 text-[11px] leading-relaxed text-[var(--bond-muted)]">寄出就到；收信的人可以回信。</p>
                        {letters.length === 0 ? <div className="mt-10 text-center text-[13px] text-[var(--bond-muted)]">還沒有信。</div> : (
                            <div className="mt-4 divide-y bond-hair border-y">
                                {letters.map(e => (
                                    <button key={e.id} type="button" className="w-full text-left py-3.5 flex items-center gap-3" onClick={() => onOpenLetter(e.id)}>
                                        <EnvelopeIcon size={20} className="shrink-0 text-[var(--bond-accent)]" />
                                        <span className="min-w-0 flex-1">
                                            <span className="block text-[11px] text-[var(--bond-muted)]">
                                                {nameOfId(space, e.author)} 寫給 {nameOfId(space, e.letter!.to)}{e.letter!.replyTo ? '・回信' : ''}{e.letter!.origin === 'story' ? '・故事裡' : ''}
                                            </span>
                                            <span className="block mt-0.5 bond-serif text-[13.5px] line-clamp-1">{e.text.replace(/\s+/g, ' ')}</span>
                                        </span>
                                        <span className="shrink-0 text-[10.5px] text-[var(--bond-muted)]">{e.letter!.sentAt ? new Date(e.letter!.sentAt).toLocaleDateString() : ''}</span>
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

/** 一件禮物：改名稱、場合、一句話；刪 */
export const PairGiftPage: React.FC<{ space: ResolvedSpace; entryId: string; onBack: () => void; addToast: Toast }> = ({ space, entryId, onBack, addToast }) => {
    const entry = bondEntryById(entryId);
    const [title, setTitle] = useState(entry?.title || '');
    const [occasion, setOccasion] = useState(entry?.gift?.occasion || '');
    const [text, setText] = useState(entry?.text || '');
    const [open, setOpen] = useState(false);
    useEffect(() => { const t = window.setTimeout(() => setOpen(true), 350); return () => window.clearTimeout(t); }, []);
    if (!entry?.gift || !space.other) return <Gone title="禮物" onBack={onBack} />;
    const look = giftWrapFor(entry.id);
    const giver = entry.gift.dir === 'out' ? space.char : space.other;
    const receiver = entry.gift.dir === 'out' ? space.other : space.char;
    const save = async () => {
        const next = withEditedText({ ...entry, title: title.trim() || undefined, gift: { ...entry.gift!, occasion: occasion.trim() || undefined } }, text);
        await saveBondEntry({ ...next, updatedAt: Date.now() });
        addToast('改好了', 'success');
        onBack();
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="禮物" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-5">
                <div className="flex flex-col items-center">
                    <GiftBox wrap={look.wrap} ribbon={look.ribbon} size={170} open={open}>
                        <span className="bond-serif text-[14px] px-2 text-center">{entry.title || entry.text}</span>
                    </GiftBox>
                    <div className="mt-2 text-[12px] text-[var(--bond-muted)]">{giver.name} 送給 {receiver.name}{entry.sources.some(s => s.type === 'story') ? '・故事裡' : ''}</div>
                </div>
                <section><SectionLabel>是 什 麼</SectionLabel><input className="bond-input bond-serif" value={title} maxLength={40} onChange={e => setTitle(e.target.value)} /></section>
                <section><SectionLabel>場 合</SectionLabel><input className="bond-input" value={occasion} maxLength={40} placeholder="可以空著" onChange={e => setOccasion(e.target.value)} /></section>
                <section><SectionLabel>那 時 候</SectionLabel><textarea className="bond-input bond-serif min-h-[90px] leading-relaxed" value={text} onChange={e => setText(e.target.value)} /></section>
                <DeleteRow label="刪掉這件禮物" warn="刪掉？他們之後就不記得。" onDelete={async () => { await deleteBondEntries([entry.id]); onBack(); }} />
            </div>
            <Footer><button type="button" className="bond-btn bond-btn-primary w-full" disabled={!title.trim() && !text.trim()} onClick={() => void save()}>存</button></Footer>
        </div>
    );
};

/** 讓某某寫一封信（或回信）：可以補一句方向 */
export const PairLetterWritePage: React.FC<{
    space: ResolvedSpace; characters: CharacterProfile[]; apiConfig: APIConfig; from: StorySide; replyToId?: string;
    onBack: () => void; onDone: (id: string) => void; addToast: Toast;
}> = ({ space, characters, apiConfig, from, replyToId, onBack, onDone, addToast }) => {
    const entries = useBondEntries(space.id);
    const [direction, setDirection] = useState('');
    const [busy, setBusy] = useState(false);
    const self = from === 'a' ? space.char : space.other!;
    const to = from === 'a' ? space.other! : space.char;
    const replyTo = replyToId ? bondEntryById(replyToId) : undefined;
    const write = async () => {
        setBusy(true);
        try {
            const e = await pairLetter(space, from, characters, entries, apiConfig, { direction, ...(replyTo ? { replyTo } : {}) });
            onDone(e.id);
        } catch (err: any) {
            addToast(err?.message || '這次沒寫成', 'error');
            setBusy(false);
        }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={replyTo ? `讓${self.name}回信` : `讓${self.name}寫信`} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-5">
                <p className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">{self.name}會照最近發生的事寫一封信給{to.name}{replyTo ? '（回那一封）' : ''}，寄出就到。</p>
                {replyTo && (
                    <div className="rounded-xl border border-[var(--bond-line)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[var(--bond-ink-2)] line-clamp-4 bond-serif">{replyTo.text}</div>
                )}
                <section>
                    <SectionLabel>想 寫 的 方 向（可 以 空 著）</SectionLabel>
                    <ExpandableTextarea value={direction} onChange={setDirection} rows={3} className="bond-input" placeholder="例如：謝謝那天的傘、說不出口的道歉" title="想寫的方向" />
                </section>
            </div>
            <Footer>
                <button type="button" className="bond-btn bond-btn-primary w-full" disabled={busy} onClick={() => void write()}>
                    <NotePencil size={14} />{busy ? `${self.name}在寫…` : '寫'}
                </button>
            </Footer>
        </div>
    );
};

/** 讀一封信：拆信、改字、刪、讓收信的人回信 */
export const PairLetterPage: React.FC<{
    space: ResolvedSpace; entryId: string; onBack: () => void; onReply: (from: StorySide, replyToId: string) => void; onOpen: (id: string) => void; addToast: Toast;
}> = ({ space, entryId, onBack, onReply, onOpen, addToast }) => {
    const entries = useBondEntries(space.id);
    const entry = entries.find(e => e.id === entryId) || bondEntryById(entryId);
    const [stage, setStage] = useState<EnvelopeStage>('closed');
    const [editing, setEditing] = useState(false);
    const [text, setText] = useState(entry?.text || '');
    useEffect(() => {
        setStage('closed');
        const t1 = window.setTimeout(() => setStage('cracked'), 300);
        const t2 = window.setTimeout(() => setStage('open'), 800);
        const t3 = window.setTimeout(() => setStage('out'), 1400);
        return () => { window.clearTimeout(t1); window.clearTimeout(t2); window.clearTimeout(t3); };
    }, [entryId]);
    if (!entry?.letter) return <Gone title="信" onBack={onBack} />;
    const author = nameOfId(space, entry.author);
    const to = nameOfId(space, entry.letter.to);
    const thread = entries.filter(e => e.kind === 'letter' && e.letter && letterRoot(entries, e.id) === letterRoot(entries, entry.id))
        .sort((x, y) => (x.letter!.sentAt || x.writtenAt) - (y.letter!.sentAt || y.writtenAt));
    const replied = entries.some(e => e.kind === 'letter' && e.letter?.replyTo === entry.id);
    const save = async () => { await saveBondEntry(withEditedText(entry, text)); setEditing(false); addToast('改好了', 'success'); };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={`${author}寫給${to}`} onBack={onBack}
                right={!editing ? <button type="button" className="bond-note px-2 py-1" onClick={() => { setText(entry.text); setEditing(true); }}>改</button> : undefined} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-6">
                {stage !== 'out' && !editing ? (
                    <div className="grid place-items-center py-10">
                        <Envelope paperStyle={entry.letter.paperStyle} wax={waxFor(entry.id)} initial={author.slice(0, 1)} stage={stage} heading={`給 ${to}`} />
                    </div>
                ) : editing ? (
                    <textarea className="bond-input bond-serif min-h-[55vh] text-[15px] leading-[1.9]" value={text} onChange={e => setText(e.target.value)} />
                ) : (
                    <div className="rounded-xl border border-[var(--bond-line)] bg-[var(--bond-card)] px-5 py-6">
                        <Paragraphs text={entry.text} />
                        <div className="mt-6 text-right text-[11px] text-[var(--bond-muted)]">{entry.letter.sentAt ? new Date(entry.letter.sentAt).toLocaleString() : ''}</div>
                    </div>
                )}
                {!editing && stage === 'out' && (
                    <div className="mt-6 space-y-4">
                        {entry.originalText !== undefined && <p className="text-[11px] text-[var(--bond-muted)]">你改過字；{to}讀到的是改過的版本。</p>}
                        {thread.length > 1 && (
                            <section>
                                <SectionLabel>這 一 串</SectionLabel>
                                <div className="divide-y bond-hair border-y">
                                    {thread.map(e => (
                                        <button key={e.id} type="button" disabled={e.id === entry.id} className="w-full text-left py-2.5 text-[12.5px] disabled:opacity-60" onClick={() => onOpen(e.id)}>
                                            {nameOfId(space, e.author)} → {nameOfId(space, e.letter!.to)}：<span className="bond-serif">{e.text.replace(/\s+/g, ' ').slice(0, 30)}…</span>
                                        </button>
                                    ))}
                                </div>
                            </section>
                        )}
                        <div className="flex flex-wrap items-center gap-3">
                            {!replied && <button type="button" className="bond-btn" onClick={() => onReply(sideOfId(space, entry.letter!.to), entry.id)}><Feather size={14} />讓{to}回信</button>}
                            <DeleteRow label="刪掉這封" warn={`刪掉？${author}和${to}之後就不記得這封信。`} onDelete={async () => { await deleteBondEntries([entry.id]); onBack(); }} />
                        </div>
                    </div>
                )}
            </div>
            {editing && (
                <Footer>
                    <button type="button" className="bond-btn flex-1" onClick={() => setEditing(false)}>不改了</button>
                    <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!text.trim()} onClick={() => void save()}>存</button>
                </Footer>
            )}
        </div>
    );
};

/** 故事裡長出來的卡，標一下是哪一章（給「拾光」以外的頁面用） */
export function storyOriginLabel(e: BondEntry, entries: BondEntry[]): string {
    const src = e.sources.find(s => s.type === 'story');
    if (!src || src.type !== 'story') return '';
    const ch = entries.find(x => x.id === src.entryId);
    return ch ? chapterLabel(ch) : '';
}
