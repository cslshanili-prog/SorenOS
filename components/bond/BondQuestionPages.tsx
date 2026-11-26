/**
 * 拾光問答的兩頁（plans/bond-batch3.md 1.2、3.2，紀要 3.7）：一題的詳細頁、出一題。
 * 誰看得到哪個答案只問 utils/bond/question.ts 的 visibleAnswer（畫面、提示詞同一個判斷）。
 */
import React, { useState } from 'react';
import { ArrowsClockwise, Lock, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, BondQuestionRound, BondQuestionTopic } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import { charAnswer, suggestQuestions } from './heartRun';
import {
    answerQuestion, lastRound, newQuestion, QUESTION_TOPIC_LABEL, startNewRound, visibleAnswer, waitingOn,
} from '../../utils/bond/question';
import { deleteBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { trackEvent } from '../../utils/analytics';

const timeText = (ts: number) => new Date(ts).toLocaleDateString();

export const BondQuestionPage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    entryId: string;
    /** 剛出完題、封存好了：一進來就請 TA 答 */
    autoAsk?: boolean;
    onBack: () => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, apiConfig, entryId, autoAsk, onBack, addToast }) => {
    const entries = useBondEntries(space.id);
    const autoAsked = React.useRef(false);
    const entry = entries.find(e => e.id === entryId);
    const name = space.rightName;
    const round = lastRound(entry?.question);
    const mine = round?.user;
    const [text, setText] = useState(mine?.state === 'draft' ? mine.text : '');
    const [busy, setBusy] = useState<'char' | 'save' | null>(null);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // 看過：角色出的題、剛揭曉的那輪（首頁「最近值得留意」用；等你回答的照樣排在前面，答了才不算）
    const revealedAt = lastRound(entry?.question)?.revealedAt || 0;
    React.useEffect(() => {
        if (!entry) return;
        const seen = entry.seenAt || 0;
        if ((entry.author !== 'user' && !seen) || (revealedAt && seen < revealedAt)) void saveBondEntry({ ...entry, seenAt: Date.now() });
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entry?.id, revealedAt]);

    React.useEffect(() => {
        if (!autoAsk || autoAsked.current || !entry) return;
        if (!waitingOn(entry).includes('char')) return;
        autoAsked.current = true;
        void askChar(entry);
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [autoAsk, entry?.id]);

    if (!entry?.question || !round) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="拾光問答" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這題已經不在了。</div>
            </div>
        );
    }
    const q = entry.question;
    const waiting = waitingOn(entry);
    const myTurn = waiting.includes('user');
    const charTurn = waiting.includes('char');

    const submit = async (state: 'draft' | 'sealed' | 'skipped') => {
        if (state !== 'skipped' && !text.trim()) { addToast('先寫下你的答案', 'info'); return; }
        setBusy('save');
        try {
            const next = answerQuestion(entry, 'user', { text, state });
            await saveBondEntry(next);
            if (state === 'draft') addToast('先存著了（只有你看得到）', 'success');
            else trackEvent('拾光问答', { 动作: state === 'skipped' ? '跳过' : '回答', 来源: q.origin === 'char' ? '角色出' : q.origin === 'ai_suggest' ? 'AI推荐' : '自己出' });
            if (state !== 'draft') setText('');
            // 你先答的（你出的題、或你按了再答一次）：封存後自動請 TA 答
            const after = waitingOn(next);
            if (state !== 'draft' && after.includes('char')) await askChar(next);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
        } finally {
            setBusy(null);
        }
    };

    const askChar = async (base: BondEntry = entry) => {
        setBusy('char');
        try {
            const out = await charAnswer(space, apiConfig, base);
            await saveBondEntry(answerQuestion(base, 'char', 'skip' in out ? { text: '', state: 'skipped' } : { text: out.answer, state: 'sealed' }));
        } catch (e: any) {
            addToast(e?.message || `${name}這次沒答出來`, 'error');
        } finally {
            setBusy(null);
        }
    };

    const reanswer = async () => {
        await saveBondEntry(startNewRound(entry, 'user'));
        setText('');
        trackEvent('拾光问答', { 动作: '再答', 来源: q.origin === 'char' ? '角色出' : q.origin === 'ai_suggest' ? 'AI推荐' : '自己出' });
    };

    const remove = async () => {
        await deleteBondEntries([entry.id]);
        onBack();
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="拾光問答" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <article className="px-6 pt-7 pb-6 border-b bond-hair">
                    <div className="bond-note">{entry.author === 'user' ? '你出的題' : `${name}出的題`}{q.topic && q.topic !== 'custom' ? ` · ${QUESTION_TOPIC_LABEL[q.topic]}` : ''}</div>
                    <h2 className="bond-serif mt-3 text-[19px] leading-snug">{q.prompt}</h2>
                </article>

                <div className="px-5 py-6 space-y-7">
                    {q.rounds.map((r, i) => (
                        <RoundView key={i} round={r} index={i} total={q.rounds.length} name={name} userName={space.leftName} />
                    ))}

                    {myTurn && (
                        <section>
                            <SectionLabel>你 的 答 案</SectionLabel>
                            <textarea className="bond-input bond-serif min-h-[110px] leading-relaxed" value={text} onChange={e => setText(e.target.value)}
                                placeholder={round.char?.state === 'sealed' ? `${name}已經答了、封存著；你答完才一起揭曉` : '寫下你的答案；封存後就不能改了'} />
                            <div className="mt-3 flex flex-wrap gap-2">
                                <button type="button" className="bond-btn" disabled={!!busy} onClick={() => submit('draft')}>先存著</button>
                                <button type="button" className="bond-btn" disabled={!!busy} onClick={() => submit('skipped')}>這題先跳過</button>
                                <button type="button" className="bond-btn bond-btn-primary" disabled={!!busy || !text.trim()} onClick={() => submit('sealed')}><Lock size={14} />封存</button>
                            </div>
                        </section>
                    )}

                    {charTurn && !myTurn && (
                        <section className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-4">
                            <div className="text-[13px] leading-relaxed text-[var(--bond-ink-2)]">
                                你的答案封存好了。{name}答完才一起揭曉{busy === 'char' ? '，正在想……' : '。'}
                            </div>
                            {busy !== 'char' && (
                                <button type="button" className="bond-btn mt-3" onClick={() => askChar()}><Sparkle size={14} />請 {name} 現在回答</button>
                            )}
                        </section>
                    )}

                    {!waiting.length && (
                        <section className="flex flex-wrap gap-2">
                            <button type="button" className="bond-btn" onClick={reanswer}><ArrowsClockwise size={14} />過一陣子再答一次</button>
                        </section>
                    )}

                    <section>
                        {!confirmDelete ? (
                            <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4" onClick={() => setConfirmDelete(true)}>刪掉這題</button>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                                <span>刪掉這題和所有回答？</span>
                                <button type="button" className="bond-btn" onClick={() => setConfirmDelete(false)}>先不要</button>
                                <button type="button" className="bond-btn bond-btn-primary" onClick={remove}>刪掉</button>
                            </div>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
};

const RoundView: React.FC<{ round: BondQuestionRound; index: number; total: number; name: string; userName: string }> = ({ round, index, total, name, userName }) => {
    const me = visibleAnswer(round, 'user', 'user');
    const them = visibleAnswer(round, 'char', 'user');
    const cell = (who: string, a: ReturnType<typeof visibleAnswer>, hiddenState: string) => (
        <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
            <div className="text-[10.5px] tracking-wider text-[var(--bond-muted)]">{who}</div>
            <div className="bond-serif mt-1 whitespace-pre-wrap text-[14px] leading-relaxed">
                {a ? (a.state === 'skipped' ? <span className="text-[var(--bond-muted)]">這題先跳過了</span> : a.state === 'draft' ? <span className="text-[var(--bond-muted)]">（還沒交出）{a.text}</span> : a.text) : <span className="text-[var(--bond-muted)]">{hiddenState}</span>}
            </div>
        </div>
    );
    const theirHidden = round.char?.state === 'sealed' ? '封存中，揭曉後才看得到' : round.char?.state === 'skipped' ? '封存中' : '還沒答';
    return (
        <section>
            <SectionLabel right={round.revealedAt ? <span className="text-[11px] text-[var(--bond-muted)]">{timeText(round.revealedAt)} 揭曉</span> : undefined}>
                {total > 1 ? `第 ${index + 1} 次` : '回 答'}
            </SectionLabel>
            <div className="grid gap-2">
                {cell(userName, me, '還沒答')}
                {cell(name, them, theirHidden)}
            </div>
        </section>
    );
};

export const BondQuestionComposePage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    onBack: () => void;
    /** sealed：封存送出了（要請 TA 答） */
    onDone: (id: string, sealed: boolean) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, apiConfig, onBack, onDone, addToast }) => {
    const entries = useBondEntries(space.id);
    const name = space.rightName;
    const [prompt, setPrompt] = useState('');
    const [topic, setTopic] = useState<BondQuestionTopic>('custom');
    const [origin, setOrigin] = useState<'user' | 'ai_suggest'>('user');
    const [answer, setAnswer] = useState('');
    const [suggestions, setSuggestions] = useState<Array<{ prompt: string; topic: BondQuestionTopic }> | null>(null);
    const [busy, setBusy] = useState<'suggest' | 'save' | null>(null);

    const suggest = async () => {
        setBusy('suggest');
        try {
            setSuggestions(await suggestQuestions(space, apiConfig, entries));
        } catch (e: any) {
            addToast(e?.message || '這次沒想出題目', 'error');
        } finally {
            setBusy(null);
        }
    };

    const save = async (state: 'draft' | 'sealed') => {
        if (!prompt.trim()) { addToast('先寫下題目', 'info'); return; }
        if (state === 'sealed' && !answer.trim()) { addToast('出題的人要先答；寫下你的答案再封存', 'info'); return; }
        setBusy('save');
        try {
            let q = newQuestion({ bondId: space.id, openedBy: 'user', prompt, origin, topic });
            if (answer.trim()) q = answerQuestion(q, 'user', { text: answer, state });
            await saveBondEntry(q);
            if (state === 'sealed') trackEvent('拾光问答', { 动作: '出题', 来源: origin === 'ai_suggest' ? 'AI推荐' : '自己出' });
            onDone(q.id, state === 'sealed');
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(null);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="出一題" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <section>
                    <SectionLabel right={<button type="button" className="text-[11.5px] text-[var(--bond-accent)] flex items-center gap-1" disabled={busy === 'suggest'} onClick={suggest}><Sparkle size={12} />{busy === 'suggest' ? '想題目中…' : suggestions ? '換幾題' : '看推薦'}</button>}>題 目</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[80px] leading-relaxed" value={prompt} maxLength={200}
                        placeholder={`例如：如果明天放假一天，你最想跟我去哪？`} onChange={e => { setPrompt(e.target.value); setOrigin('user'); }} />
                    {suggestions && (
                        <div className="mt-3 divide-y bond-hair border-y">
                            {suggestions.map((s, i) => (
                                <button key={i} type="button" className="w-full text-left py-2.5 flex items-start gap-3" onClick={() => { setPrompt(s.prompt); setTopic(s.topic); setOrigin('ai_suggest'); }}>
                                    <span className="shrink-0 mt-0.5 text-[10.5px] text-[var(--bond-muted)] w-8">{QUESTION_TOPIC_LABEL[s.topic]}</span>
                                    <span className="bond-serif text-[13.5px] leading-relaxed">{s.prompt}</span>
                                </button>
                            ))}
                        </div>
                    )}
                </section>
                <section>
                    <SectionLabel>主 題</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        {(Object.keys(QUESTION_TOPIC_LABEL) as BondQuestionTopic[]).map(t => (
                            <button key={t} type="button" className="bond-chip" aria-pressed={topic === t} onClick={() => setTopic(t)}>{QUESTION_TOPIC_LABEL[t]}</button>
                        ))}
                    </div>
                </section>
                <section>
                    <SectionLabel>你 的 答 案</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[110px] leading-relaxed" value={answer} onChange={e => setAnswer(e.target.value)}
                        placeholder={`出題的人先答。封存後題目才會送到${name}那邊，TA 答完才一起揭曉。`} />
                </section>
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" disabled={!!busy || !prompt.trim()} onClick={() => save('draft')}>先存著</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!!busy || !prompt.trim() || !answer.trim()} onClick={() => save('sealed')}><Lock size={14} />封存並送出</button>
            </div>
        </div>
    );
};
