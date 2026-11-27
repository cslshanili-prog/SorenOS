/**
 * 故事存下後的回寫清單（plans/bond-batch6.md 2.3、2.4）：全螢幕，照第 2 批「挑幾件」的樣子。
 * 進來先整理（抽事件、兩人各寫日記與記憶、信的全文），列出來你勾、能改字；按「寫進去」才寫。
 * 會改階段的里程碑寫成首頁的承認卡，你按「對」才改。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CharacterProfile } from '../../types';
import type { ResolvedSpace } from './space';
import { BondHeader, SectionLabel } from './bondUi';
import { useSpaceTimeline } from './useSpaceTimeline';
import { applyStoryWriteback, prepareStoryWriteback } from './storyWriteback';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { milestoneLabel, repeatLabel } from '../../utils/bond/pact';
import { SYNC_KINDS } from '../../utils/bond/eventCards';
import { stageLabel } from '../../utils/bond/routes';
import { chapterLabel } from '../../utils/bond/story';
import { STORY_WRITE_LABEL, STORY_WRITE_ORDER, defaultChecked, type StoryWriteItem } from '../../utils/bond/storyExtract';

type Toast = (m: string, t?: 'success' | 'error' | 'info') => void;
type Updater = (id: string, updates: (prev: CharacterProfile) => Partial<CharacterProfile>) => void;

const SECTION_HINT: Partial<Record<StoryWriteItem['kind'], string>> = {
    moment: '進拾光，事實、第三人稱',
    milestone: '進約定 › 里程碑',
    wish: '進約定；故事裡已經說出口了',
    promise: '進約定；故事裡已經說好了，直接成立',
    habit: '進約定；兩人都認',
    gift: '進珍藏 › 禮物',
    letter: '進珍藏 › 信件；全文是寄信的那位另外寫的，寄出就到',
    diary: '進心意 › 日記，各自寫自己怎麼看',
    memory: '兩人各自記得（話題盒；開了記憶宮殿也送一份），標「用戶不在場」',
};

export const BondStoryWritebackPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    entryId: string;
    apiConfig: APIConfig;
    updateCharacter: Updater;
    /** 寫完或先不寫：回閱讀頁 */
    onDone: () => void;
    addToast: Toast;
}> = ({ space, characters, entryId, apiConfig, updateCharacter, onDone, addToast }) => {
    const { entries } = useSpaceTimeline(space, characters);
    const story: BondEntry | undefined = entries.find(e => e.id === entryId) || bondEntryById(entryId);
    const a = space.char, b = space.other;
    const [items, setItems] = useState<StoryWriteItem[] | null>(null);
    const [checked, setChecked] = useState<Set<string>>(new Set());
    const [failed, setFailed] = useState<string[]>([]);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState<'prep' | 'save' | null>(null);
    const abortRef = useRef<AbortController | null>(null);
    const entriesRef = useRef(entries);
    entriesRef.current = entries;

    const prepare = async () => {
        if (!story?.story) return;
        abortRef.current?.abort();
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        setBusy('prep'); setError(''); setItems(null);
        try {
            const draft = await prepareStoryWriteback(space, story, entriesRef.current, apiConfig, ctrl.signal);
            if (ctrl.signal.aborted) return;
            setItems(draft.items);
            setFailed(draft.failed);
            setChecked(defaultChecked(draft.items, space.bond.pairAutoDiary !== false));
        } catch (e: any) {
            if (ctrl.signal.aborted) return;
            setError(e?.message || String(e));
        } finally {
            if (!ctrl.signal.aborted) setBusy(null);
        }
    };
    useEffect(() => {
        void prepare();
        return () => abortRef.current?.abort();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [entryId]);

    const nameOf = (side: 'a' | 'b') => (side === 'a' ? a.name : b?.name || '');
    const groups = useMemo(() => STORY_WRITE_ORDER
        .map(kind => ({ kind, list: (items || []).filter(i => i.kind === kind) }))
        .filter(g => g.list.length), [items]);

    const patch = (key: string, p: Partial<StoryWriteItem>) => setItems(prev => (prev || []).map(i => (i.key === key ? { ...i, ...p } as StoryWriteItem : i)));
    const toggle = (key: string) => setChecked(prev => { const next = new Set(prev); if (next.has(key)) next.delete(key); else next.add(key); return next; });

    const save = async () => {
        if (!story || !items) return;
        setBusy('save');
        try {
            const picked = items.filter(i => checked.has(i.key));
            const r = await applyStoryWriteback({ space, story, items: picked, apiConfig, updateCharacter });
            addToast(r.proposals ? `寫進去了；有 ${r.proposals} 件關係轉折在首頁等你確認` : picked.length ? '寫進去了' : '這一章記成整理過了', 'success');
            onDone();
        } catch (e: any) {
            addToast(`沒寫成功：${e?.message || e}`, 'error');
            setBusy(null);
        }
    };

    const leave = () => { abortRef.current?.abort(); onDone(); };

    if (!story?.story || !b) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="整理回寫" onBack={onDone} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這一章已經不在了。</div>
            </div>
        );
    }

    const tag = (it: StoryWriteItem): string => {
        switch (it.kind) {
            case 'milestone': return it.sync
                ? `${SYNC_KINDS[it.what]?.label || it.what}・要你確認${it.sync.stageTo ? `（改成「${stageLabel({ route: it.sync.routeTo || space.bond.route, stage: it.sync.stageTo })}」）` : ''}`
                : milestoneLabel(it.what, it.label);
            case 'wish': return it.owner === 'both' ? '他們兩人的' : `${nameOf(it.owner)}的`;
            case 'promise': return repeatLabel(it.repeat);
            case 'gift': return `${nameOf(it.from)} 送 ${nameOf(it.from === 'a' ? 'b' : 'a')}${it.occasion ? `・${it.occasion}` : ''}`;
            case 'letter': return `${nameOf(it.from)} 寫給 ${nameOf(it.from === 'a' ? 'b' : 'a')}${it.about ? `・${it.about}` : ''}`;
            case 'diary': return `${nameOf(it.side)}的日記`;
            case 'memory': return `${nameOf(it.side)}記得的`;
            default: return '';
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="整理回寫" onBack={leave} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5">
                <p className="text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                    〈{chapterLabel(story)}〉裡真的發生的事。勾起來的才會寫進他們的空間，每一項都能改字；不想要的取消勾就好。
                </p>
                {busy === 'prep' && (
                    <div className="mt-12 text-center text-[13px] leading-relaxed text-[var(--bond-muted)]">
                        整理這一章裡發生的事…<br /><span className="text-[11.5px]">{a.name}和{b.name}也在各自寫日記</span>
                    </div>
                )}
                {error && (
                    <div className="mt-10 text-center">
                        <div className="text-[13px] text-[var(--bond-ink-2)]">{error}</div>
                        <button type="button" className="bond-btn mt-3" onClick={() => void prepare()}><Sparkle size={14} />再整理一次</button>
                    </div>
                )}
                {items && !busy && failed.length > 0 && (
                    <div className="mt-4 rounded-xl border border-[var(--bond-line)] px-3.5 py-3 text-[12px] leading-relaxed text-[var(--bond-ink-2)]">
                        這幾樣這次沒整理出來：{failed.join('、')}。
                        <button type="button" className="ml-1 underline underline-offset-2 text-[var(--bond-accent)]" onClick={() => void prepare()}>整份重來</button>
                    </div>
                )}
                {items && !busy && !items.length && (
                    <div className="mt-10 text-center text-[13px] leading-relaxed text-[var(--bond-muted)]">這一章裡沒整理出要記的事。</div>
                )}
                {items && busy !== 'prep' && groups.map(g => (
                    <section key={g.kind} className="mt-6">
                        <SectionLabel>{STORY_WRITE_LABEL[g.kind]}</SectionLabel>
                        <p className="-mt-1 mb-2 text-[11px] text-[var(--bond-muted)]">{SECTION_HINT[g.kind]}</p>
                        <div className="divide-y bond-hair border-y">
                            {g.list.map(it => {
                                const on = checked.has(it.key);
                                const long = it.kind === 'diary' || it.kind === 'letter';
                                return (
                                    <div key={it.key} className={`py-3.5 flex gap-3 ${on ? '' : 'opacity-55'}`}>
                                        <button type="button" aria-pressed={on} aria-label={on ? '取消勾' : '勾起來'} onClick={() => toggle(it.key)}
                                            className={`mt-1 h-4 w-4 shrink-0 rounded-[4px] border grid place-items-center ${on ? 'bg-[var(--bond-accent)] border-[var(--bond-accent)] text-[#fbf7f0]' : 'border-[var(--bond-rose)]'}`}>
                                            {on && <Check size={11} weight="bold" />}
                                        </button>
                                        <div className="min-w-0 flex-1 space-y-1.5">
                                            {tag(it) && (
                                                <span className="inline-block px-1.5 py-px rounded border border-[var(--bond-line)] text-[10.5px] text-[var(--bond-accent)]">{tag(it)}</span>
                                            )}
                                            {(it.kind === 'moment' || it.kind === 'gift') && (
                                                <input className="bond-input bond-serif text-[14.5px]" value={it.title} maxLength={it.kind === 'gift' ? 40 : 30}
                                                    placeholder={it.kind === 'gift' ? '送了什麼' : '標題（可以空著）'} onChange={e => patch(it.key, { title: e.target.value })} />
                                            )}
                                            <textarea className={`bond-input leading-relaxed ${long ? 'bond-serif min-h-[180px] text-[14px]' : 'min-h-[64px] text-[13.5px]'}`}
                                                value={it.text} placeholder={it.kind === 'letter' ? '信沒寫出來；可以自己補，空著就不寫' : ''}
                                                onChange={e => patch(it.key, { text: e.target.value })} />
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    </section>
                ))}
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" disabled={busy === 'save'} onClick={leave}>先不寫</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={!items || !!busy}
                    onClick={() => void save()}>{busy === 'save' ? '寫進去…' : checked.size ? `寫進去（${[...checked].filter(k => items?.some(i => i.key === k)).length} 件）` : '都不寫'}</button>
            </div>
        </div>
    );
};
