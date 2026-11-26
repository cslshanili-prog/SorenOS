/**
 * 讀一篇隨筆（plans/bond-batch2.md 5.2）：書頁排版，標題、「寫於某天 · 關於那件事」、正文，後記依序接在下面。
 * 重開就是讀存好的原文，不重新生成。草稿在這裡收下、重寫或丟掉；收下才進提示詞（角色才記得自己寫過）。
 * 你改過的，可以看「原本的版本」。
 */
import React, { useState } from 'react';
import { ArrowsClockwise, ChatCircleText, Check, Feather, PencilSimple, Trash } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, CharacterProfile } from '../../types';
import { BondAvatar, BondHeader } from './bondUi';
import type { ResolvedSpace } from './space';
import { useSpaceTimeline } from './useSpaceTimeline';
import { itemHeadline } from './BondMomentsPage';
import { runEssay, writtenDayText } from './essayRun';
import { essayRoot, essayThread, rewriteDraft } from '../../utils/bond/essay';
import { essayTargetKey } from '../../utils/bond/timeline';
import { dependentsOf, planRetract } from '../../utils/bond/derivation';
import { deleteBondEntries, saveBondEntries, saveBondEntry } from '../../utils/bond/entries';
import { formatEventDate } from '../../utils/bond/eventDate';
import { trackEvent } from '../../utils/analytics';

type EssayWay = '指定事件' | '让TA挑' | '后记';
export const essayWayOf = (e: BondEntry, chosen?: boolean): EssayWay => (e.afterwordOf ? '后记' : chosen ? '让TA挑' : '指定事件');

export const BondEssayPage: React.FC<{
    space: ResolvedSpace;
    characters: CharacterProfile[];
    apiConfig: APIConfig;
    essayId: string;
    /** 這篇是「讓 TA 挑」寫出來的（收下／丟掉時埋點用） */
    chosen?: boolean;
    onBack: () => void;
    onOpenItem: (key: string) => void;
    onEdit: (essayId: string) => void;
    onAfterword: (baseId: string) => void;
    onBringToChat?: (essayId: string) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, characters, apiConfig, essayId, chosen, onBack, onOpenItem, onEdit, onAfterword, onBringToChat, addToast }) => {
    const { items, entries } = useSpaceTimeline(space, characters);
    const root = essayRoot(entries, essayId);
    const thread = root ? essayThread(entries, root.id) : [];
    const [busyId, setBusyId] = useState<string | null>(null);
    const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({});
    const [confirming, setConfirming] = useState<string | null>(null);

    if (!root) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="隨筆" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這篇已經不在了。</div>
            </div>
        );
    }

    const byId = new Map(entries.map(e => [e.id, e]));
    const targetKey = essayTargetKey(root, byId);
    const target = targetKey ? items.find(i => i.key === targetKey) : undefined;
    const authorOf = (e: BondEntry) => characters.find(c => c.id === e.author) || (e.author === space.char.id ? space.char : space.other);

    const accept = async (e: BondEntry) => {
        await saveBondEntry({ ...e, status: 'published', updatedAt: Date.now() });
        trackEvent('生成角色随笔', { 方式: essayWayOf(e, chosen && e.id === essayId), 结果: '收下' });
        addToast(`收下了，${authorOf(e)?.name || 'TA'} 會記得自己寫過`, 'success');
    };

    const discard = async (e: BondEntry) => {
        const plan = planRetract(entries, { type: 'entry', id: e.id }, 'cascade');
        await deleteBondEntries([...new Set([e.id, ...plan.deleteIds])]);
        trackEvent('生成角色随笔', { 方式: essayWayOf(e, chosen && e.id === essayId), 结果: '丢掉' });
        if (e.id === root.id) onBack();
    };

    const rewrite = async (e: BondEntry) => {
        setBusyId(e.id);
        try {
            const base = e.afterwordOf ? byId.get(e.afterwordOf) : undefined;
            const out = await runEssay({
                space, characters, items, entries: entries.filter(x => x.id !== e.id), apiConfig, writerId: e.author,
                mode: base ? 'afterword' : 'event', item: base ? undefined : target, base,
            });
            await saveBondEntry(rewriteDraft(e, out.parsed));
        } catch (err: any) {
            addToast(err?.message || '這次沒寫出來', 'error');
        } finally {
            setBusyId(null);
        }
    };

    const remove = async (e: BondEntry, mode: 'cascade' | 'detach') => {
        const plan = planRetract(entries, { type: 'entry', id: e.id }, mode);
        if (plan.updates.length) await saveBondEntries(plan.updates);
        await deleteBondEntries([...new Set([e.id, ...plan.deleteIds])]);
        setConfirming(null);
        addToast('刪掉了', 'success');
        if (e.id === root.id) onBack();
    };

    const last = thread[thread.length - 1];

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="隨筆" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <div className="px-6 pt-6">
                    {target ? (
                        <button type="button" onClick={() => onOpenItem(target.key)} className="bond-note text-left">
                            關於 {formatEventDate(target.eventDate)} · {itemHeadline(target, 24)} ›
                        </button>
                    ) : (
                        <div className="bond-note">{root.orphanedLinks?.length ? '原本關聯的那件事已刪除' : `關於 ${formatEventDate(root.eventDate)}`}</div>
                    )}
                </div>
                {thread.map((e, idx) => {
                    const author = authorOf(e);
                    const deps = dependentsOf(entries, { type: 'entry', id: e.id });
                    const original = showOriginal[e.id];
                    return (
                        <article key={e.id} className={`px-6 pt-6 pb-7 ${idx > 0 ? 'border-t bond-hair' : ''}`}>
                            <div className="flex items-center gap-2 text-[11px] text-[var(--bond-muted)]">
                                <BondAvatar value={author?.avatar} name={author?.name} size={18} />
                                <span>{author?.name || '—'} · {idx > 0 ? '後記 · ' : ''}寫於 {writtenDayText(space, e.writtenAt)}{e.revisedAt ? ' · 你改過' : ''}</span>
                            </div>
                            {e.title?.trim() && <h2 className="bond-serif mt-3 text-[19px] leading-snug">{e.title}</h2>}
                            <div className="bond-serif mt-3 whitespace-pre-wrap text-[15.5px] leading-[1.95]">
                                {original && e.originalText ? e.originalText : e.text}
                            </div>
                            {e.originalText && (
                                <button type="button" className="mt-3 text-[11.5px] text-[var(--bond-accent)]"
                                    onClick={() => setShowOriginal(prev => ({ ...prev, [e.id]: !prev[e.id] }))}>
                                    {original ? '看改過的版本' : '看原本的版本'}
                                </button>
                            )}

                            {e.status === 'draft' ? (
                                <div className="mt-5 rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3.5">
                                    <div className="text-[12.5px] leading-relaxed text-[var(--bond-ink-2)]">
                                        這是草稿。收下之後 {author?.name || 'TA'} 才會記得自己寫過這篇。
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <button type="button" className="bond-btn bond-btn-primary" disabled={!!busyId} onClick={() => accept(e)}><Check size={14} />收下</button>
                                        <button type="button" className="bond-btn" disabled={!!busyId} onClick={() => rewrite(e)}>
                                            <ArrowsClockwise size={14} />{busyId === e.id ? '重寫中…' : '重寫'}
                                        </button>
                                        <button type="button" className="bond-btn" disabled={!!busyId} onClick={() => onEdit(e.id)}><PencilSimple size={14} />改一改</button>
                                        <button type="button" className="bond-btn" disabled={!!busyId} onClick={() => discard(e)}><Trash size={14} />丟掉</button>
                                    </div>
                                </div>
                            ) : (
                                <div className="mt-5 flex flex-wrap gap-2">
                                    {onBringToChat && space.kind === 'persona' && (
                                        <button type="button" className="bond-btn" onClick={() => onBringToChat(e.id)}><ChatCircleText size={14} />帶去聊聊</button>
                                    )}
                                    <button type="button" className="bond-btn" onClick={() => onEdit(e.id)}><PencilSimple size={14} />編輯</button>
                                    {confirming !== e.id && <button type="button" className="bond-btn" onClick={() => setConfirming(e.id)}><Trash size={14} />刪除</button>}
                                </div>
                            )}

                            {confirming === e.id && (
                                <div className="mt-4 rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-4">
                                    <div className="text-[13px] leading-relaxed">
                                        刪掉這篇？{deps.length > 0 ? `底下還有 ${deps.length} 篇後記，要一起刪，還是留著（後記變成獨立的一篇）？` : `${author?.name || 'TA'} 之後就不會記得寫過它。`}
                                    </div>
                                    <div className="mt-3 flex flex-wrap gap-2">
                                        <button type="button" className="bond-btn" onClick={() => setConfirming(null)}>先不要</button>
                                        {deps.length > 0 ? (
                                            <>
                                                <button type="button" className="bond-btn" onClick={() => remove(e, 'detach')}>刪掉，後記留著</button>
                                                <button type="button" className="bond-btn bond-btn-primary" onClick={() => remove(e, 'cascade')}>連後記一起刪</button>
                                            </>
                                        ) : (
                                            <button type="button" className="bond-btn bond-btn-primary" onClick={() => remove(e, 'cascade')}>刪掉</button>
                                        )}
                                    </div>
                                </div>
                            )}
                        </article>
                    );
                })}
                {last && last.status === 'published' && (
                    <div className="px-6 pb-12">
                        <button type="button" onClick={() => onAfterword(last.id)}
                            className="w-full flex items-center justify-between rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3 text-left">
                            <span>
                                <span className="bond-serif block text-[14px]">現在回頭看</span>
                                <span className="block mt-0.5 text-[11.5px] text-[var(--bond-muted)]">請 {authorOf(last)?.name || 'TA'} 就同一件事再寫一段，原文不動</span>
                            </span>
                            <Feather size={16} className="text-[var(--bond-accent)]" />
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
};
