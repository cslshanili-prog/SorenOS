/**
 * 角色之間「他們的故事」的頁面（plans/bond-batch6.md 第 1、2 節）：
 * 首頁的故事區與讀者視角概覽、寫故事頁、閱讀頁、章節目錄、改一章。全部全螢幕。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowsClockwise, BookOpen, CaretLeft, CaretRight, Feather, PencilSimple, Sparkle, Trash } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { BondAvatar, BondHeader, SectionLabel } from './bondUi';
import { useSpaceTimeline } from './useSpaceTimeline';
import { runOverview, runStory, summarizeStory } from './storyRun';
import ExpandableTextarea from '../common/ExpandableTextarea';
import {
    chapterLabel, chapterNeighbors, newStoryEntry, nextChapterNo, normalizeWords, overviewStale, storyChapters, STORY_SCENES,
} from '../../utils/bond/story';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { updateBond } from '../../utils/bond/store';
import { formatEventDate } from '../../utils/bond/eventDate';
import { trackEvent } from '../../utils/analytics';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;

const Footer: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>{children}</div>
);

const SCENE_EVENT: Record<string, string> = { '日常': '日常', '約會／出遊': '约会', '節日': '节日', '吵架和好': '吵架和好', '意外': '意外', '深夜談心': '深夜' };
const sceneEvent = (scene?: string) => (scene ? SCENE_EVENT[scene] || '自订' : '日常');

/** 故事正文的閱讀排版：空行分段 */
const StoryText: React.FC<{ text: string }> = ({ text }) => (
    <div className="bond-serif text-[15.5px] leading-[1.95] text-[var(--bond-ink)] space-y-4">
        {text.split(/\n{2,}/).map((p, i) => <p key={i} className="whitespace-pre-wrap">{p}</p>)}
    </div>
);

// ─── 首頁：他們的故事＋讀者視角概覽 ───────────────────

export const PairStoryHome: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    onOpen: (entryId: string) => void;
    onWrite: () => void;
    onList: () => void;
    addToast: Toast;
}> = ({ space, characters, apiConfig, onOpen, onWrite, onList, addToast }) => {
    const { items, entries } = useSpaceTimeline(space, characters);
    const chapters = useMemo(() => storyChapters(entries), [entries]);
    const latest = chapters.at(-1);
    const overview = space.bond.pairOverview;
    const stale = overviewStale(overview, entries);
    const [busy, setBusy] = useState(false);
    const [text, setText] = useState(overview?.text || '');
    useEffect(() => { setText(space.bond.pairOverview?.text || ''); }, [space.bond.pairOverview?.text]);

    const refresh = async () => {
        setBusy(true);
        try {
            const out = await runOverview(space, apiConfig, items, entries);
            const chapter = latest?.story?.chapter || 0;
            await updateBond(space.id, b => ({ ...b, pairOverview: { text: out, at: Date.now(), chapter }, updatedAt: Date.now() }));
            setText(out);
            trackEvent('更新关系概览', {});
        } catch (e: any) {
            addToast(e?.message || '這次沒寫出來', 'error');
        } finally {
            setBusy(false);
        }
    };

    return (
        <>
            <section>
                <SectionLabel right={chapters.length > 0 ? <button type="button" className="text-[11.5px] text-[var(--bond-accent)]" onClick={onList}>全部章節（{chapters.length}）</button> : undefined}>
                    他 們 的 故 事
                </SectionLabel>
                {latest ? (
                    <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3.5">
                        <button type="button" className="w-full text-left" onClick={() => onOpen(latest.id)}>
                            <div className="text-[11px] text-[var(--bond-muted)]">{formatEventDate(latest.eventDate)}</div>
                            <div className="bond-serif mt-1 text-[15px]">{chapterLabel(latest)}</div>
                            <p className="mt-1.5 text-[12.5px] leading-relaxed text-[var(--bond-ink-2)] line-clamp-2">{latest.text.replace(/\s+/g, ' ')}</p>
                        </button>
                        <div className="mt-3 flex gap-2">
                            <button type="button" className="bond-btn flex-1" onClick={() => onOpen(latest.id)}><BookOpen size={14} />讀下去</button>
                            <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={onWrite}><Feather size={14} />寫下一章</button>
                        </div>
                    </div>
                ) : (
                    <button type="button" onClick={onWrite} className="w-full rounded-xl border border-dashed border-[var(--bond-rose)] px-4 py-4 text-left">
                        <div className="bond-serif text-[14.5px]">寫他們的第一個故事</div>
                        <div className="mt-1 text-[11.5px] leading-relaxed text-[var(--bond-muted)]">你是讀者，也是作者：給個方向，讓 AI 寫一章 {space.leftName} 和 {space.rightName} 之間的事。存下的故事他們都會記得。</div>
                    </button>
                )}
            </section>
            {(chapters.length > 0 || text) && (
                <section>
                    <SectionLabel right={
                        <button type="button" disabled={busy} onClick={refresh} className="text-[11.5px] text-[var(--bond-accent)] inline-flex items-center gap-1 disabled:opacity-40">
                            <ArrowsClockwise size={12} />{busy ? '寫著…' : text ? '更新' : '寫一段'}
                        </button>
                    }>故 事 走 到 哪 了</SectionLabel>
                    {text ? (
                        <>
                            <p className="bond-serif text-[13.5px] leading-[1.85] text-[var(--bond-ink-2)] whitespace-pre-wrap">{text}</p>
                            {stale && <div className="mt-1.5 text-[11px] text-[var(--bond-accent)]">有新章節，可以更新。</div>}
                        </>
                    ) : (
                        <p className="text-[12.5px] text-[var(--bond-muted)]">按「寫一段」，用讀者的口吻寫一段他們的故事走到哪了。</p>
                    )}
                </section>
            )}
        </>
    );
};

// ─── 寫故事 ─────────────────────────────────────────

interface Draft { title: string; text: string }
interface DraftStore { drafts: Draft[]; current: number; settings: { pov: string; scene?: string; direction: string; standalone: boolean; chapter: number } }

const draftKey = (bondId: string) => `bond_story_draft_${bondId}`;
const loadDraft = (bondId: string): DraftStore | null => { try { const v = localStorage.getItem(draftKey(bondId)); return v ? JSON.parse(v) : null; } catch { return null; } };
const saveDraft = (bondId: string, d: DraftStore | null) => { try { if (d) localStorage.setItem(draftKey(bondId), JSON.stringify(d)); else localStorage.removeItem(draftKey(bondId)); } catch { /* 存不了只是下次要重寫 */ } };

export const BondStoryComposePage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    onBack: () => void;
    onSaved: (entryId: string) => void;
    addToast: Toast;
}> = ({ space, characters, apiConfig, onBack, onSaved, addToast }) => {
    const { items, entries } = useSpaceTimeline(space, characters);
    const a = space.char, b = space.other!;
    const prefs = space.bond.pairStoryPrefs;
    const kept = useMemo(() => loadDraft(space.id), [space.id]);
    const [pov, setPov] = useState<string>(kept?.settings.pov || prefs?.pov || 'narrator');
    const [scene, setScene] = useState<string | undefined>(kept?.settings.scene);
    const [direction, setDirection] = useState(kept?.settings.direction || '');
    const [standalone, setStandalone] = useState(!!kept?.settings.standalone);
    const [minWords, setMinWords] = useState(prefs?.words ? String(prefs.words[0]) : '');
    const [maxWords, setMaxWords] = useState(prefs?.words ? String(prefs.words[1]) : '');
    const [style, setStyle] = useState(prefs?.style || '');
    const [drafts, setDrafts] = useState<Draft[]>(kept?.drafts || []);
    const [current, setCurrent] = useState(kept?.current ?? 0);
    const [editing, setEditing] = useState(false);
    const [busy, setBusy] = useState<'write' | 'save' | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    const hasChapters = storyChapters(entries).length > 0;
    const chapter = kept?.settings.chapter && drafts.length ? kept.settings.chapter : nextChapterNo(entries);
    const words = normalizeWords(minWords, maxWords);
    const draft = drafts[current];
    const settings = { pov, scene, direction, standalone, chapter };

    const write = async (again: boolean) => {
        if (!words) { addToast('先填篇幅：大約幾字到幾字', 'info'); return; }
        setBusy('write');
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
            const out = await runStory({ space, characters, items, entries, apiConfig, chapter, pov, direction, scene, words, style, standalone: hasChapters && standalone, signal: ctrl.signal });
            const next = [...drafts, out].slice(-5);
            setDrafts(next);
            setCurrent(next.length - 1);
            setEditing(false);
            saveDraft(space.id, { drafts: next, current: next.length - 1, settings });
            await updateBond(space.id, bd => ({ ...bd, pairStoryPrefs: { words, style: style.trim() || undefined, pov }, updatedAt: Date.now() }));
            trackEvent('羁绊故事', { 动作: again ? '重写' : '写', 视角: pov === 'narrator' ? '旁白' : '角色', 场景: sceneEvent(scene) });
        } catch (e: any) {
            if (ctrl.signal.aborted) return;
            addToast(e?.message || '這次沒寫出來', 'error');
        } finally {
            if (!ctrl.signal.aborted) setBusy(null);
        }
    };

    const patchDraft = (patch: Partial<Draft>) => {
        const next = drafts.map((d, i) => (i === current ? { ...d, ...patch } : d));
        setDrafts(next);
        saveDraft(space.id, { drafts: next, current, settings });
    };

    const discard = () => {
        saveDraft(space.id, null);
        setDrafts([]);
        setCurrent(0);
        setEditing(false);
        trackEvent('羁绊故事', { 动作: '丢掉', 视角: pov === 'narrator' ? '旁白' : '角色', 场景: sceneEvent(scene) });
    };

    const save = async () => {
        if (!draft?.text.trim()) return;
        setBusy('save');
        try {
            const summary = await summarizeStory(space, apiConfig, draft.title, draft.text);
            const entry = await saveBondEntry(newStoryEntry({
                bondId: space.id, chapter, title: draft.title, text: draft.text, summary, pov,
                direction, scene, words, standalone: hasChapters && standalone, dateKey: space.todayKey,
            }));
            saveDraft(space.id, null);
            trackEvent('羁绊故事', { 动作: '存下', 视角: pov === 'narrator' ? '旁白' : '角色', 场景: sceneEvent(scene) });
            addToast(`第 ${chapter} 章存下了`, 'success');
            onSaved(entry.id);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(null);
        }
    };

    const leave = () => { abortRef.current?.abort(); onBack(); };

    if (draft) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title={`第 ${chapter} 章・草稿`} onBack={leave}
                    right={drafts.length > 1 ? (
                        <div className="flex items-center gap-1 text-[11.5px] text-[var(--bond-muted)]">
                            <button type="button" aria-label="上一版" disabled={current === 0} className="p-1 disabled:opacity-30" onClick={() => setCurrent(c => c - 1)}><CaretLeft size={14} /></button>
                            {current + 1}/{drafts.length}
                            <button type="button" aria-label="下一版" disabled={current === drafts.length - 1} className="p-1 disabled:opacity-30" onClick={() => setCurrent(c => c + 1)}><CaretRight size={14} /></button>
                        </div>
                    ) : undefined} />
                <div className="flex-1 overflow-y-auto no-scrollbar px-6 py-6">
                    {editing ? (
                        <div className="space-y-3">
                            <input className="bond-input bond-serif" value={draft.title} maxLength={30} placeholder="章名" onChange={e => patchDraft({ title: e.target.value })} />
                            <textarea className="bond-input bond-serif min-h-[60vh] text-[15px] leading-[1.9]" value={draft.text} onChange={e => patchDraft({ text: e.target.value })} />
                        </div>
                    ) : (
                        <>
                            <h2 className="bond-serif text-[19px] text-center">{draft.title || `第 ${chapter} 章`}</h2>
                            <div className="mt-1 mb-6 text-center text-[11px] text-[var(--bond-muted)]">
                                {pov === 'narrator' ? '旁白' : `${characters.find(c => c.id === pov)?.name || ''}的視角`}・約 {draft.text.length} 字
                            </div>
                            <StoryText text={draft.text} />
                        </>
                    )}
                </div>
                <Footer>
                    <button type="button" className="bond-btn" disabled={!!busy} onClick={discard} aria-label="丟掉"><Trash size={14} /></button>
                    <button type="button" className="bond-btn" disabled={!!busy} onClick={() => setEditing(v => !v)}><PencilSimple size={14} />{editing ? '看排版' : '改'}</button>
                    <button type="button" className="bond-btn" disabled={!!busy} onClick={() => void write(true)}><ArrowsClockwise size={14} />{busy === 'write' ? '寫著…' : '重寫'}</button>
                    <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!!busy || !draft.text.trim()} onClick={save}>{busy === 'save' ? '存檔中…' : '存下'}</button>
                </Footer>
            </div>
        );
    }

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={`寫第 ${chapter} 章`} onBack={leave} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                <section>
                    <SectionLabel>方 向</SectionLabel>
                    <textarea className="bond-input min-h-[72px] leading-relaxed" value={direction} maxLength={300}
                        placeholder="可以不填，例如：第一次一起出門旅行／為了一件小事冷戰" onChange={e => setDirection(e.target.value)} />
                    <div className="mt-2 flex flex-wrap gap-2">
                        {STORY_SCENES.map(s => (
                            <button key={s} type="button" className="bond-chip" aria-pressed={scene === s} onClick={() => setScene(scene === s ? undefined : s)}>{s}</button>
                        ))}
                    </div>
                </section>
                <section>
                    <SectionLabel>視 角</SectionLabel>
                    <div className="flex flex-wrap gap-2">
                        <button type="button" className="bond-chip" aria-pressed={pov === 'narrator'} onClick={() => setPov('narrator')}>旁白</button>
                        {[a, b].map(c => (
                            <button key={c.id} type="button" className="bond-chip flex items-center gap-1.5" aria-pressed={pov === c.id} onClick={() => setPov(c.id)}>
                                <BondAvatar value={c.avatar} name={c.name} size={18} />{c.name}的視角
                            </button>
                        ))}
                    </div>
                </section>
                <section>
                    <SectionLabel>篇 幅</SectionLabel>
                    <div className="flex items-center gap-2">
                        <span className="shrink-0 whitespace-nowrap text-[13px] text-[var(--bond-ink-2)]">大約</span>
                        <input className="bond-input min-w-0 flex-1 text-center" inputMode="numeric" value={minWords} placeholder="1200" onChange={e => setMinWords(e.target.value.replace(/\D/g, ''))} />
                        <span className="shrink-0 text-[13px] text-[var(--bond-ink-2)]">～</span>
                        <input className="bond-input min-w-0 flex-1 text-center" inputMode="numeric" value={maxWords} placeholder="2000" onChange={e => setMaxWords(e.target.value.replace(/\D/g, ''))} />
                        <span className="shrink-0 text-[13px] text-[var(--bond-ink-2)]">字</span>
                    </div>
                    {!words && <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">兩格都填了才能寫；下次會記得這次填的。</div>}
                </section>
                <section>
                    <SectionLabel>文 風</SectionLabel>
                    <ExpandableTextarea value={style} onChange={setStyle} title="文風" rows={2} maxLength={600}
                        className="bond-input leading-relaxed" placeholder="可以不填，例如：克制、留白，多寫動作少寫心理" />
                    <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">會記成這段關係寫故事的預設文風。</div>
                </section>
                {hasChapters && (
                    <section>
                        <label className="flex items-center justify-between gap-3">
                            <span>
                                <span className="block text-[13px]">獨立一篇</span>
                                <span className="block mt-0.5 text-[11px] text-[var(--bond-muted)]">不接前情（不帶之前各章），只照時間線寫</span>
                            </span>
                            <input type="checkbox" className="h-4 w-4 accent-[var(--bond-accent)]" checked={standalone} onChange={e => setStandalone(e.target.checked)} />
                        </label>
                    </section>
                )}
                <p className="text-[11.5px] leading-relaxed text-[var(--bond-muted)]">
                    你不在故事裡。寫好先是草稿，可以重寫、改、丟掉；按「存下」才算數，{a.name}和{b.name}都會記得。
                </p>
            </div>
            <Footer>
                <button type="button" className="bond-btn bond-btn-primary w-full" disabled={!!busy || !words} onClick={() => void write(false)}>
                    <Sparkle size={15} />{busy === 'write' ? '寫著這一章…' : '寫'}
                </button>
            </Footer>
        </div>
    );
};

// ─── 閱讀一章 ───────────────────────────────────────

export const BondStoryReadPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    entryId: string;
    onBack: () => void;
    onOpen: (entryId: string) => void;
    onEdit: (entryId: string) => void;
    onWriteNext: () => void;
    /** 刪一章（6d 會先列出衍生物） */
    onDelete?: (entry: BondEntry) => void;
    addToast: Toast;
}> = ({ space, characters, entryId, onBack, onOpen, onEdit, onWriteNext, onDelete, addToast }) => {
    const { entries } = useSpaceTimeline(space, characters);
    const entry = entries.find(e => e.id === entryId) || bondEntryById(entryId);
    const { prev, next } = chapterNeighbors(entries, entryId);
    const [confirm, setConfirm] = useState(false);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    useEffect(() => { scrollRef.current?.scrollTo(0, 0); setConfirm(false); }, [entryId]);

    if (!entry?.story) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="故事" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這一章已經不在了。</div>
            </div>
        );
    }
    const pov = entry.story.pov === 'narrator' ? '旁白' : `${characters.find(c => c.id === entry.story!.pov)?.name || ''}的視角`;
    const remove = async () => {
        if (onDelete) { onDelete(entry); return; }
        await deleteBondEntries([entry.id]);
        trackEvent('羁绊故事', { 动作: '删', 视角: entry.story!.pov === 'narrator' ? '旁白' : '角色', 场景: sceneEvent(entry.story!.scene) });
        addToast('刪掉了', 'success');
        onBack();
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={`第 ${entry.story.chapter} 章`} onBack={onBack}
                right={<button type="button" className="bond-note px-2 py-1" onClick={() => onEdit(entry.id)}>改</button>} />
            <div ref={scrollRef} className="flex-1 overflow-y-auto no-scrollbar px-6 py-6">
                <h2 className="bond-serif text-[19px] text-center">{entry.title}</h2>
                <div className="mt-1 mb-6 text-center text-[11px] text-[var(--bond-muted)]">{formatEventDate(entry.eventDate)}・{pov}</div>
                <StoryText text={entry.text} />
                <div className="mt-10 mb-2 flex items-center justify-between gap-2">
                    {prev ? <button type="button" className="bond-btn" onClick={() => onOpen(prev.id)}><CaretLeft size={14} />{chapterLabel(prev)}</button> : <span />}
                    {next ? <button type="button" className="bond-btn" onClick={() => onOpen(next.id)}>{chapterLabel(next)}<CaretRight size={14} /></button>
                        : <button type="button" className="bond-btn bond-btn-primary" onClick={onWriteNext}><Feather size={14} />寫下一章</button>}
                </div>
                <div className="mt-8 border-t bond-hair pt-4">
                    {!confirm ? (
                        <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-2" onClick={() => setConfirm(true)}>刪掉這一章</button>
                    ) : (
                        <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
                            <p className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">刪掉第 {entry.story.chapter} 章？之後的章節不會重新編號。</p>
                            <div className="mt-2.5 flex gap-2">
                                <button type="button" className="bond-btn flex-1" onClick={() => setConfirm(false)}>先不要</button>
                                <button type="button" className="bond-btn bond-btn-primary flex-1" onClick={() => void remove()}><Trash size={14} />刪掉</button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

// ─── 章節目錄 ───────────────────────────────────────

export const BondStoryListPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    onBack: () => void;
    onOpen: (entryId: string) => void;
    onWrite: () => void;
}> = ({ space, characters, onBack, onOpen, onWrite }) => {
    const { entries } = useSpaceTimeline(space, characters);
    const chapters = storyChapters(entries);
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="他們的故事" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-4">
                {chapters.length === 0 ? (
                    <p className="py-16 text-center text-[13px] text-[var(--bond-muted)]">還沒有故事。</p>
                ) : (
                    <div className="divide-y bond-hair">
                        {chapters.map(e => (
                            <button key={e.id} type="button" className="w-full text-left py-4" onClick={() => onOpen(e.id)}>
                                <div className="flex items-baseline justify-between gap-3">
                                    <span className="bond-serif text-[15px]">{chapterLabel(e)}</span>
                                    <span className="shrink-0 text-[11px] text-[var(--bond-muted)]">{formatEventDate(e.eventDate)}</span>
                                </div>
                                <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--bond-ink-2)] line-clamp-3">{e.story!.summary || e.text.slice(0, 120)}</p>
                            </button>
                        ))}
                    </div>
                )}
            </div>
            <Footer>
                <button type="button" className="bond-btn bond-btn-primary w-full" onClick={onWrite}><Feather size={14} />寫下一章</button>
            </Footer>
        </div>
    );
};

// ─── 改一章 ─────────────────────────────────────────

export const BondStoryEditPage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    entryId: string;
    onBack: () => void;
    /** 存好之後（6d：內文改了會問要不要重新整理回寫） */
    onSaved: (entry: BondEntry, textChanged: boolean) => void;
    addToast: Toast;
}> = ({ space, apiConfig, entryId, onBack, onSaved, addToast }) => {
    const entry = bondEntryById(entryId);
    const [title, setTitle] = useState(entry?.title || '');
    const [text, setText] = useState(entry?.text || '');
    const [date, setDate] = useState(entry?.eventDate.precision === 'day' ? entry.eventDate.date : '');
    const [resummarize, setResummarize] = useState(true);
    const [busy, setBusy] = useState(false);
    if (!entry?.story) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="改一章" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這一章已經不在了。</div>
            </div>
        );
    }
    const textChanged = text.trim() !== entry.text.trim();
    const save = async () => {
        if (!text.trim()) return;
        setBusy(true);
        try {
            const summary = textChanged && resummarize ? await summarizeStory(space, apiConfig, title, text) : entry.story!.summary;
            const now = Date.now();
            const saved = await saveBondEntry({
                ...entry, title: title.trim() || `第 ${entry.story!.chapter} 章`, text: text.trim(),
                eventDate: /^\d{4}-\d{2}-\d{2}$/.test(date) ? { precision: 'day', date } : entry.eventDate,
                story: { ...entry.story!, summary },
                ...(textChanged && !entry.originalText ? { originalText: entry.text } : {}),
                ...(textChanged ? { revisedAt: now } : {}),
                updatedAt: now,
            });
            trackEvent('羁绊故事', { 动作: '改', 视角: entry.story!.pov === 'narrator' ? '旁白' : '角色', 场景: sceneEvent(entry.story!.scene) });
            addToast('存好了', 'success');
            onSaved(saved, textChanged);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(false);
        }
    };
    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={`改第 ${entry.story.chapter} 章`} onBack={onBack} backLabel="取消" />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-5">
                <section>
                    <SectionLabel>章 名</SectionLabel>
                    <input className="bond-input bond-serif" value={title} maxLength={30} onChange={e => setTitle(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>故 事 裡 的 日 期</SectionLabel>
                    <input type="date" className="bond-input" value={date} onChange={e => setDate(e.target.value)} />
                </section>
                <section>
                    <SectionLabel>正 文</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[55vh] text-[15px] leading-[1.9]" value={text} onChange={e => setText(e.target.value)} />
                </section>
                {textChanged && (
                    <label className="flex items-center justify-between gap-3">
                        <span className="text-[12.5px] text-[var(--bond-ink-2)]">內容改了，順便重寫這一章的摘要</span>
                        <input type="checkbox" className="h-4 w-4 accent-[var(--bond-accent)]" checked={resummarize} onChange={e => setResummarize(e.target.checked)} />
                    </label>
                )}
            </div>
            <Footer>
                <button type="button" className="bond-btn flex-1" onClick={onBack}>取消</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !text.trim()} onClick={save}>{busy ? '存檔中…' : '存'}</button>
            </Footer>
        </div>
    );
};
