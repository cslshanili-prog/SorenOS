/**
 * 拾光裡一件事的詳細頁（plans/bond-batch2.md 4.2）：片刻、記憶、角色私聊的整理都用這頁。
 * - 記憶的編輯、刪除走神經鏈接同一條路（utils/memoryArchiveEdit.ts；刪除只刪檔案記錄，宮殿節點保留）。
 * - 刪掉一件事時，建在它上面的隨筆要你選：一起刪，或留著、拆掉關聯（utils/bond/derivation.ts）。
 */
import React, { useState } from 'react';
import { ArrowCounterClockwise, ChatCircleText, EyeSlash, Feather, PencilSimple, Star, Trash } from '@phosphor-icons/react';
import type { BondSource, CharacterProfile, MemoryFragment } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useSpaceTimeline } from './useSpaceTimeline';
import type { TimelineItem } from '../../utils/bond/timeline';
import { itemKindLabel } from './BondMomentsPage';
import { BondPhotoStrip } from './BondPhotoPicker';
import { formatEventDate } from '../../utils/bond/eventDate';
import { essayThread } from '../../utils/bond/essay';
import { dependentsOf, planRetract, type DerivationRef } from '../../utils/bond/derivation';
import { deleteBondEntries, saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { updateBond } from '../../utils/bond/store';

const SOURCE_LABEL = { message: '私聊', date: '見面', memory: '記憶', photo: '照片', story: '故事' } as const;

export const BondItemPage: React.FC<{
    space: ResolvedSpace;
    itemKey: string;
    characters: CharacterProfile[];
    onBack: () => void;
    onEditMoment: (entryId: string) => void;
    onEditMemory: (memoryId: string) => void;
    /** 點來源跳回當時那則 */
    onOpenSource?: (source: BondSource) => void;
    /** 角色之間：從哪一章故事長出來的，開那一章（plans/bond-batch6.md 2.3） */
    onOpenStory?: (entryId: string) => void;
    /** 記憶：在神經鏈接（記憶分頁）或記憶宮殿打開 */
    onOpenMemory?: (charId: string, where: 'link' | 'palace') => void;
    onOpenEssay?: (essayId: string) => void;
    /** 請角色就這件事寫隨筆 */
    onWriteEssay?: () => void;
    /** 帶去聊聊（只有身份卡 × 角色的空間） */
    onBringToChat?: (item: TimelineItem) => void;
    updateCharacter: (id: string, updates: Partial<CharacterProfile> | ((prev: CharacterProfile) => Partial<CharacterProfile>)) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, itemKey, characters, onBack, onEditMoment, onEditMemory, onOpenSource, onOpenStory, onOpenMemory, onOpenEssay, onWriteEssay, onBringToChat, updateCharacter, addToast }) => {
    const { items, entries } = useSpaceTimeline(space, characters);
    const item = items.find(i => i.key === itemKey);
    const [confirming, setConfirming] = useState(false);
    const [busy, setBusy] = useState(false);

    if (!item) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="拾光" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這件事已經不在了。</div>
            </div>
        );
    }

    const ref = item.ref;
    const derivRef: DerivationRef = ref.type === 'entry' ? { type: 'entry', id: ref.entry.id }
        : ref.type === 'memory' ? { type: 'memory', memoryId: ref.memory.id } : { type: 'memory', memoryId: ref.topic.id };
    const dependents = dependentsOf(entries, derivRef);

    // 收藏、收起：片刻存在卡上，記憶存在 bonds.memoryMarks（不改記憶本身）
    const setMark = async (patch: { favorite?: boolean; hidden?: boolean }) => {
        try {
            if (ref.type === 'entry') {
                await saveBondEntry({ ...ref.entry, ...patch });
            } else {
                const markId = ref.type === 'memory' ? ref.memory.id : ref.topic.id;
                await updateBond(space.id, b => ({ ...b, memoryMarks: { ...(b.memoryMarks || {}), [markId]: { ...(b.memoryMarks?.[markId] || {}), ...patch } } }));
            }
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
        }
    };

    const remove = async (mode: 'cascade' | 'detach') => {
        setBusy(true);
        try {
            const plan = planRetract(entries, derivRef, mode);
            if (plan.updates.length) await saveBondEntries(plan.updates);
            if (ref.type === 'memory') {
                // 跟神經鏈接的刪除同一個效果：只拿掉檔案記錄，有宮殿關聯的節點保留
                const memoryId = ref.memory.id;
                updateCharacter(ref.charId, prev => ({ memories: (prev.memories || []).filter((m: MemoryFragment) => m.id !== memoryId) }));
                await updateBond(space.id, b => {
                    if (!b.memoryMarks?.[memoryId]) return b;
                    const { [memoryId]: _gone, ...rest } = b.memoryMarks;
                    return { ...b, memoryMarks: rest };
                });
            }
            await deleteBondEntries(plan.deleteIds);
            addToast('刪掉了', 'success');
            onBack();
        } catch (e: any) {
            addToast(`沒刪成功：${e?.message || e}`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const entry = ref.type === 'entry' ? ref.entry : null;
    const memory = ref.type === 'memory' ? ref.memory : null;
    const canEdit = ref.type !== 'topic';

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="拾光" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <article className="px-6 pt-7 pb-6 border-b bond-hair">
                    <div className="bond-note">{itemKindLabel(item, space)} · {formatEventDate(item.eventDate)}</div>
                    {entry?.title?.trim() && <h2 className="bond-serif mt-3 text-[20px] leading-snug">{entry.title}</h2>}
                    <div className={`bond-serif mt-3 whitespace-pre-wrap text-[15.5px] leading-[1.95] ${entry?.title ? 'text-[var(--bond-ink-2)]' : ''}`}>{item.text}</div>
                    {entry && entry.sources.some(src => src.type === 'photo') && (
                        <div className="mt-4"><BondPhotoStrip galleryIds={entry.sources.flatMap(src => (src.type === 'photo' ? [src.galleryId] : []))} /></div>
                    )}
                    {entry?.note?.trim() && (
                        <p className="mt-5 border-l-2 border-[var(--bond-rose)] pl-3 text-[13px] leading-relaxed text-[var(--bond-ink-2)]">
                            {entry.author === 'user' ? '想留著它，因為：' : ''}{entry.note}
                        </p>
                    )}
                    {memory?.mood && <div className="mt-4 text-[11.5px] text-[var(--bond-muted)]">那天的心情：{memory.mood}</div>}
                    {memory?.palaceMemoryId && <div className="mt-1 text-[11px] text-[var(--bond-muted)]">這筆跟記憶宮殿連著，改了兩邊一起變。</div>}
                    {memory && ref.type === 'memory' && onOpenMemory && (
                        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px]">
                            <button type="button" className="text-[var(--bond-accent)]" onClick={() => onOpenMemory(ref.charId, 'link')}>在神經鏈接打開 ›</button>
                            {memory.palaceMemoryId && characters.find(c => c.id === ref.charId)?.memoryPalaceEnabled && (
                                <button type="button" className="text-[var(--bond-accent)]" onClick={() => onOpenMemory(ref.charId, 'palace')}>在記憶宮殿打開 ›</button>
                            )}
                        </div>
                    )}
                    {ref.type === 'topic' && <div className="mt-4 text-[11.5px] text-[var(--bond-muted)]">這是他們私下聊滿一段之後自動整理的，只能收藏或收起。</div>}
                </article>

                <div className="px-5 py-6 space-y-7">
                    {entry && (entry.sources.some(src => src.type !== 'photo') || (entry.orphanedLinks?.length || 0) > 0) && (
                        <section>
                            <SectionLabel>來 源</SectionLabel>
                            <ul className="space-y-2.5">
                                {entry.sources.filter(src => src.type !== 'photo').map((s, i) => {
                                    const jumpable = ((s.type === 'message' || s.type === 'date') && !!onOpenSource) || (s.type === 'story' && !!onOpenStory);
                                    const label = s.type === 'message' && s.lineId.startsWith('pair~') ? '角色私聊' : SOURCE_LABEL[s.type];
                                    return (
                                        <li key={i} className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">
                                            <div className="flex items-center justify-between gap-3">
                                                <span className="text-[var(--bond-muted)]">{label}{'at' in s && s.at ? ` · ${new Date(s.at).toLocaleDateString()}` : ''}</span>
                                                {jumpable && (
                                                    <button type="button" onClick={() => (s.type === 'story' ? onOpenStory!(s.entryId) : onOpenSource!(s))} className="shrink-0 text-[11.5px] text-[var(--bond-accent)]">{s.type === 'story' ? '讀那一章 ›' : '回到那時 ›'}</button>
                                                )}
                                            </div>
                                            {'snippet' in s && s.snippet ? <span className="block mt-1 whitespace-pre-wrap bond-serif">{s.snippet}</span> : null}
                                        </li>
                                    );
                                })}
                                {(entry.orphanedLinks?.length || 0) > 0 && (
                                    <li className="text-[12px] text-[var(--bond-muted)]">原本關聯的那件事已刪除。</li>
                                )}
                            </ul>
                        </section>
                    )}

                    {(item.essays.length > 0 || onWriteEssay) && (
                        <section>
                            <SectionLabel right={onWriteEssay ? (
                                <button type="button" className="text-[11.5px] text-[var(--bond-accent)] flex items-center gap-1" onClick={onWriteEssay}>
                                    <Feather size={12} />{space.kind === 'pair' ? '請他們寫隨筆' : `請 ${space.rightName} 寫隨筆`}
                                </button>
                            ) : undefined}>隨 筆</SectionLabel>
                            {item.essays.length > 0 ? (
                                <div className="divide-y bond-hair border-y">
                                    {item.essays.filter(e => !e.afterwordOf || !item.essays.some(x => x.id === e.afterwordOf)).map(e => {
                                        const author = characters.find(c => c.id === e.author);
                                        const afterwords = essayThread(item.essays, e.id).length - 1;
                                        return (
                                            <button key={e.id} type="button" onClick={() => onOpenEssay?.(e.id)} className="w-full text-left py-3 text-[13.5px] leading-relaxed">
                                                <span className="bond-serif">{(e.title || e.text).slice(0, 60)}</span>
                                                <span className="block mt-0.5 text-[11px] text-[var(--bond-muted)]">
                                                    {author?.name || ''}{e.status === 'draft' ? ' · 草稿' : ''}{afterwords && !e.afterwordOf ? ` · 後記 ${afterwords}` : ''}
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            ) : (
                                <div className="text-[12px] text-[var(--bond-muted)]">還沒有人就這件事寫過什麼。</div>
                            )}
                        </section>
                    )}

                    <section className="flex flex-wrap gap-2">
                        {onBringToChat && (
                            <button type="button" className="bond-btn" onClick={() => onBringToChat(item)}><ChatCircleText size={14} />帶去聊聊</button>
                        )}
                        <button type="button" className="bond-btn" onClick={() => setMark({ favorite: !item.favorite })}>
                            <Star size={14} weight={item.favorite ? 'fill' : 'regular'} className={item.favorite ? 'text-[var(--bond-accent)]' : ''} />
                            {item.favorite ? '取消收藏' : '收藏'}
                        </button>
                        <button type="button" className="bond-btn" onClick={() => setMark({ hidden: !item.hidden })}>
                            {item.hidden ? <ArrowCounterClockwise size={14} /> : <EyeSlash size={14} />}
                            {item.hidden ? '放回時間線' : '收起'}
                        </button>
                        {canEdit && (
                            <button type="button" className="bond-btn" onClick={() => (entry ? onEditMoment(entry.id) : memory && onEditMemory(memory.id))}>
                                <PencilSimple size={14} />編輯
                            </button>
                        )}
                        {canEdit && !confirming && (
                            <button type="button" className="bond-btn" onClick={() => setConfirming(true)}><Trash size={14} />刪除</button>
                        )}
                    </section>

                    {confirming && (
                        <section className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-4">
                            <div className="text-[13px] leading-relaxed">
                                {memory
                                    ? '這筆記憶會從神經鏈接的記憶裡刪掉（跟在神經鏈接刪除一樣，只刪檔案記錄，記憶宮殿裡關聯的那筆保留）。'
                                    : '刪掉這個片刻？'}
                            </div>
                            {dependents.length > 0 && (
                                <div className="mt-2 text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">
                                    有 {dependents.length} 篇隨筆是寫這件事的。要一起刪掉，還是留著（隨筆會標「原本關聯的那件事已刪除」）？
                                </div>
                            )}
                            <div className="mt-3 flex flex-wrap gap-2">
                                <button type="button" className="bond-btn" disabled={busy} onClick={() => setConfirming(false)}>先不要</button>
                                {dependents.length > 0 ? (
                                    <>
                                        <button type="button" className="bond-btn" disabled={busy} onClick={() => remove('detach')}>刪掉，隨筆留著</button>
                                        <button type="button" className="bond-btn bond-btn-primary" disabled={busy} onClick={() => remove('cascade')}>連隨筆一起刪</button>
                                    </>
                                ) : (
                                    <button type="button" className="bond-btn bond-btn-primary" disabled={busy} onClick={() => remove('detach')}>刪掉</button>
                                )}
                            </div>
                        </section>
                    )}
                </div>
            </div>
        </div>
    );
};
