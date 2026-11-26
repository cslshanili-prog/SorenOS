/**
 * 請角色寫一篇隨筆（plans/bond-batch2.md 5.1）：指定一件事、讓 TA 自己挑一件、或就一篇隨筆寫後記。
 * 可以補一句想請 TA 寫的方向；寫出來是草稿，接著開隨筆頁讓你收下、重寫或丟掉。
 */
import React, { useEffect, useRef, useState } from 'react';
import { Feather } from '@phosphor-icons/react';
import type { APIConfig, CharacterProfile } from '../../types';
import { BondAvatar, BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useSpaceTimeline } from './useSpaceTimeline';
import { itemHeadline } from './BondMomentsPage';
import { essayOtherName, essayWriterOf, runEssay } from './essayRun';
import { essayDraft, type EssayMode } from '../../utils/bond/essay';
import { saveBondEntry } from '../../utils/bond/entries';
import { formatEventDate } from '../../utils/bond/eventDate';

export const BondEssayComposePage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    mode: EssayMode;
    /** event：那件事 */
    itemKey?: string;
    /** afterword：接在哪篇後面 */
    baseId?: string;
    onBack: () => void;
    /** 草稿存好了，開隨筆頁 */
    onDone: (essayId: string) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, characters, apiConfig, mode, itemKey, baseId, onBack, onDone, addToast }) => {
    const { items, entries } = useSpaceTimeline(space, characters);
    const isPair = space.kind === 'pair';
    const base = baseId ? entries.find(e => e.id === baseId) : undefined;
    const item = itemKey ? items.find(i => i.key === itemKey) : undefined;
    const [writerId, setWriterId] = useState<string>(() => base?.author && base.author !== 'user' ? base.author : space.char.id);
    const [hint, setHint] = useState('');
    const [busy, setBusy] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    useEffect(() => () => abortRef.current?.abort(), []);

    const writer = essayWriterOf(space, writerId);
    const otherName = essayOtherName(space, writerId);
    const missing = (mode === 'event' && !item) || (mode === 'afterword' && !base);

    const write = async () => {
        setBusy(true);
        const ctrl = new AbortController();
        abortRef.current = ctrl;
        try {
            const out = await runEssay({ space, characters, items, entries, apiConfig, writerId, mode, item, base, hint, signal: ctrl.signal });
            const draft = await saveBondEntry(essayDraft({ bondId: space.id, writerId, item: out.item, afterwordOf: mode === 'afterword' ? base : undefined, parsed: out.parsed }));
            onDone(draft.id);
        } catch (e: any) {
            if (ctrl.signal.aborted) return;
            addToast(e?.message || '這次沒寫出來', 'error');
        } finally {
            if (!ctrl.signal.aborted) setBusy(false);
        }
    };

    const title = mode === 'afterword' ? '現在回頭看' : mode === 'choose' ? `讓 ${isPair ? '他們' : writer.name} 寫一篇` : '寫一篇隨筆';

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={title} onBack={() => { abortRef.current?.abort(); onBack(); }} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                {missing ? (
                    <div className="py-16 text-center text-[13px] text-[var(--bond-muted)]">那件事已經不在了。</div>
                ) : (
                    <>
                        {isPair && mode !== 'afterword' && (
                            <section>
                                <SectionLabel>誰 來 寫</SectionLabel>
                                <div className="flex gap-2">
                                    {[space.char, space.other!].map(c => (
                                        <button key={c.id} type="button" className="bond-chip flex items-center gap-1.5" aria-pressed={writerId === c.id} onClick={() => setWriterId(c.id)}>
                                            <BondAvatar value={c.avatar} name={c.name} size={18} />{c.name}
                                        </button>
                                    ))}
                                </div>
                            </section>
                        )}
                        <section>
                            <SectionLabel>{mode === 'choose' ? '從 哪 些 事 裡 挑' : '關 於'}</SectionLabel>
                            {mode === 'choose' ? (
                                <p className="text-[13px] leading-relaxed text-[var(--bond-ink-2)]">{writer.name}會從最近、還沒寫過的片刻和記憶裡，挑一件現在最想寫的。</p>
                            ) : (
                                <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
                                    {item && <div className="text-[11px] text-[var(--bond-muted)]">{formatEventDate(item.eventDate)}</div>}
                                    <div className="bond-serif mt-1 text-[14px] leading-relaxed">{item ? itemHeadline(item, 120) : base ? base.text.slice(0, 120) : ''}</div>
                                    {mode === 'afterword' && <div className="mt-2 text-[11.5px] text-[var(--bond-muted)]">原本那篇不會改，後記接在下面。</div>}
                                </div>
                            )}
                        </section>
                        <section>
                            <SectionLabel>想 請 {writer.name} 寫 的 方 向</SectionLabel>
                            <textarea className="bond-input min-h-[88px] leading-relaxed" value={hint} maxLength={200}
                                placeholder={`可以不填，例如：那天你為什麼沒說話`} onChange={e => setHint(e.target.value)} />
                            <div className="mt-1.5 text-[11px] leading-relaxed text-[var(--bond-muted)]">
                                {writer.name}寫的是自己的感想，{otherName}看得到。寫好先是草稿，你按「收下」{writer.name}才會記得自己寫過。
                            </div>
                        </section>
                    </>
                )}
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn bond-btn-primary w-full" disabled={busy || missing} onClick={write}>
                    <Feather size={15} />{busy ? `${writer.name}正在寫…` : `請 ${writer.name} 寫`}
                </button>
            </div>
        </div>
    );
};
