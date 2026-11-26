/**
 * 心靈角落的兩頁（plans/bond-batch3.md 1.3、3.2，紀要 3.8）：讀一張紙條（含回應串、狀態），寫一張。
 * 投遞才算說出口：你的草稿只有你看得到，角色的提示詞也不會有（utils/bond/visibility.ts）。
 */
import React, { useEffect, useState } from 'react';
import { PaperPlaneTilt, Plus, Sparkle } from '@phosphor-icons/react';
import type { APIConfig, BondEntry, BondSlip } from '../../types';
import { BondHeader, SectionLabel } from './bondUi';
import type { ResolvedSpace } from './space';
import { useBondEntries } from './useSpaceTimeline';
import { charSlipReply } from './heartRun';
import { deliverSlip, markSlipSeen, newSlip, setSlipState, SLIP_STATE_LABEL, slipReplies, slipTagOptions } from '../../utils/bond/slip';
import { bondEntryById } from '../../utils/bond/entryRegistry';
import { deleteBondEntries, saveBondEntry, saveBondEntries } from '../../utils/bond/entries';
import { updateBond } from '../../utils/bond/store';
import { trackEvent } from '../../utils/analytics';

const whenText = (e: BondEntry) => new Date(e.slip?.deliveredAt || e.writtenAt).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export const BondSlipPage: React.FC<{
    space: ResolvedSpace;
    apiConfig: APIConfig;
    entryId: string;
    onBack: () => void;
    onReply: (rootId: string) => void;
    onEditDraft: (id: string) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, apiConfig, entryId, onBack, onReply, onEditDraft, addToast }) => {
    const entries = useBondEntries(space.id);
    const root = entries.find(e => e.id === entryId);
    const name = space.rightName;
    const replies = root ? slipReplies(entries, root.id, 'user') : [];
    const [busy, setBusy] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);

    // 打開就算讀過 TA 丟來的（這張和這串裡 TA 的回應）
    useEffect(() => {
        if (!root) return;
        const unseen = [root, ...replies].filter(e => e.author !== 'user' && e.status === 'published' && !e.slip?.seenAt);
        if (unseen.length) void saveBondEntries(unseen.map(e => markSlipSeen(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [root?.id, replies.length]);

    if (!root) {
        return (
            <div className="absolute inset-0 flex flex-col bond-root">
                <BondHeader title="心靈角落" onBack={onBack} />
                <div className="flex-1 grid place-items-center text-[13px] text-[var(--bond-muted)]">這張紙條已經不在了。</div>
            </div>
        );
    }
    const fromMe = root.author === 'user';
    const who = (e: BondEntry) => (e.author === 'user' ? '你' : name);
    // 狀態由收到的那方標：TA 丟的你來標；你丟的，TA 標的狀態唯讀顯示（第 3c 批 TA 才會標）
    const canMark = !fromMe && root.status === 'published';

    const mark = async (state: BondSlip['state'] | null) => {
        await saveBondEntry(setSlipState(root, state));
        if (state) trackEvent('标记纸条状态', { 状态: SLIP_STATE_LABEL[state] === '想再談' ? '想再谈' : SLIP_STATE_LABEL[state] === '已回應' ? '已回应' : '已说开' });
    };

    const askReply = async () => {
        setBusy(true);
        try {
            const text = await charSlipReply(space, apiConfig, entries, root);
            const reply = deliverSlip(newSlip({ bondId: space.id, author: space.char.id, text, tags: [], replyTo: root.id }));
            await saveBondEntry(reply);
            trackEvent('投递心灵纸条', { 谁: '角色', 方式: '请TA回' });
        } catch (e: any) {
            addToast(e?.message || `${name}這次沒回`, 'error');
        } finally {
            setBusy(false);
        }
    };

    const remove = async () => {
        // 回在下面的一起刪（紙條串不留孤兒）
        await deleteBondEntries([root.id, ...slipReplies(entries, root.id, 'user').map(e => e.id)]);
        onBack();
    };

    const lastFromMe = [root, ...replies.filter(e => e.status === 'published')].slice(-1)[0]?.author === 'user';

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title="心靈角落" onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar">
                <article className="px-6 pt-7 pb-6 border-b bond-hair">
                    <div className="bond-note">{fromMe ? '你丟的' : `${name}丟的`} · {root.status === 'draft' ? '草稿，還沒投遞' : whenText(root)}</div>
                    {(root.slip?.tags || []).length > 0 && (
                        <div className="mt-3 flex flex-wrap gap-1.5">{root.slip!.tags.map(t => <span key={t} className="bond-chip" aria-pressed>{t}</span>)}</div>
                    )}
                    <div className="bond-serif mt-4 whitespace-pre-wrap text-[16px] leading-[1.95]">{root.text}</div>
                    {root.status === 'draft' && (
                        <button type="button" className="bond-btn mt-4" onClick={() => onEditDraft(root.id)}>繼續寫／投遞</button>
                    )}
                </article>

                <div className="px-5 py-6 space-y-7">
                    {root.status === 'published' && (
                        <section>
                            <SectionLabel>狀 態</SectionLabel>
                            {canMark ? (
                                <div className="flex flex-wrap gap-2">
                                    {(Object.keys(SLIP_STATE_LABEL) as Array<NonNullable<BondSlip['state']>>).map(s => (
                                        <button key={s} type="button" className="bond-chip" aria-pressed={root.slip?.state === s} onClick={() => mark(root.slip?.state === s ? null : s)}>{SLIP_STATE_LABEL[s]}</button>
                                    ))}
                                </div>
                            ) : (
                                <div className="text-[12.5px] text-[var(--bond-ink-2)]">{root.slip?.state ? `${name}標了「${SLIP_STATE_LABEL[root.slip.state]}」` : `${name}還沒標`}</div>
                            )}
                            <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">有回應不等於已經說開。</div>
                        </section>
                    )}

                    {replies.length > 0 && (
                        <section>
                            <SectionLabel>回 應</SectionLabel>
                            <div className="divide-y bond-hair border-y">
                                {replies.map(r => (
                                    <div key={r.id} className="py-3.5">
                                        <div className="text-[10.5px] tracking-wider text-[var(--bond-muted)]">{who(r)} · {r.status === 'draft' ? '草稿' : whenText(r)}</div>
                                        <div className="bond-serif mt-1 whitespace-pre-wrap text-[14px] leading-relaxed">{r.text}</div>
                                        {r.status === 'draft' && <button type="button" className="mt-2 text-[11.5px] text-[var(--bond-accent)]" onClick={() => onEditDraft(r.id)}>繼續寫／投遞</button>}
                                    </div>
                                ))}
                            </div>
                        </section>
                    )}

                    {root.status === 'published' && (
                        <section className="flex flex-wrap gap-2">
                            <button type="button" className="bond-btn" onClick={() => onReply(root.id)}><Plus size={14} />回一張</button>
                            {lastFromMe && (
                                <button type="button" className="bond-btn" disabled={busy} onClick={askReply}><Sparkle size={14} />{busy ? `${name}在寫…` : `請 ${name} 回`}</button>
                            )}
                        </section>
                    )}

                    <section>
                        {!confirmDelete ? (
                            <button type="button" className="text-[11.5px] text-[var(--bond-muted)] underline underline-offset-4" onClick={() => setConfirmDelete(true)}>刪掉這張</button>
                        ) : (
                            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
                                <span>刪掉這張{replies.length ? '和底下的回應' : ''}？{root.status === 'published' ? `${name}之後就不會記得。` : ''}</span>
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

export const BondSlipComposePage: React.FC<{
    space: ResolvedSpace;
    /** 編輯現有的草稿 */
    entryId?: string;
    /** 回哪張（新寫一張回應時） */
    replyTo?: string;
    onBack: () => void;
    onDone: (rootId: string) => void;
    addToast: (m: string, t?: 'success' | 'error' | 'info') => void;
}> = ({ space, entryId, replyTo, onBack, onDone, addToast }) => {
    const existing = entryId ? bondEntryById(entryId) : undefined;
    const parentId = existing?.slip?.replyTo || replyTo;
    const parent = parentId ? bondEntryById(parentId) : undefined;
    const name = space.rightName;
    const [text, setText] = useState(existing?.text || '');
    const [tags, setTags] = useState<string[]>(existing?.slip?.tags || []);
    const [customTags, setCustomTags] = useState<string[]>(space.bond.noteTags || []);
    const [adding, setAdding] = useState('');
    const [busy, setBusy] = useState(false);
    const options = slipTagOptions(customTags);

    const addTag = async () => {
        const t = adding.trim().slice(0, 12);
        if (!t) return;
        if (!options.includes(t)) {
            const next = [...customTags, t];
            setCustomTags(next);
            await updateBond(space.id, b => ({ ...b, noteTags: next }));
        }
        setTags(prev => (prev.includes(t) ? prev : [...prev, t]));
        setAdding('');
    };

    const save = async (deliver: boolean) => {
        if (!text.trim()) return;
        setBusy(true);
        try {
            const base = existing
                ? { ...existing, text: text.trim(), slip: { ...(existing.slip || { tags: [] }), tags }, writtenAt: Date.now(), updatedAt: Date.now() }
                : newSlip({ bondId: space.id, author: 'user', text, tags, replyTo: parentId });
            const saved = await saveBondEntry(deliver ? deliverSlip(base) : base);
            if (deliver) trackEvent('投递心灵纸条', { 谁: '我', 方式: '自己写' });
            addToast(deliver ? `投遞了，${name}現在知道了` : '存成草稿了（只有你看得到）', 'success');
            onDone(saved.slip?.replyTo || saved.id);
        } catch (e: any) {
            addToast(`沒存成功：${e?.message || e}`, 'error');
            setBusy(false);
        }
    };

    return (
        <div className="absolute inset-0 flex flex-col bond-root">
            <BondHeader title={parent ? '回一張紙條' : '寫一張紙條'} onBack={onBack} />
            <div className="flex-1 overflow-y-auto no-scrollbar px-5 py-5 space-y-6">
                {parent && (
                    <div className="rounded-xl border bond-hair bg-[var(--bond-card)] px-4 py-3">
                        <div className="text-[10.5px] tracking-wider text-[var(--bond-muted)]">{parent.author === 'user' ? '你丟的' : `${name}丟的`}</div>
                        <div className="bond-serif mt-1 text-[13.5px] leading-relaxed">{parent.text.slice(0, 160)}</div>
                    </div>
                )}
                {!parent && (
                    <section>
                        <SectionLabel>標 籤</SectionLabel>
                        <div className="flex flex-wrap gap-2">
                            {options.map(t => (
                                <button key={t} type="button" className="bond-chip" aria-pressed={tags.includes(t)} onClick={() => setTags(prev => (prev.includes(t) ? prev.filter(x => x !== t) : [...prev, t]))}>{t}</button>
                            ))}
                        </div>
                        <div className="mt-3 flex gap-2">
                            <input className="bond-input flex-1" value={adding} maxLength={12} placeholder="加一個標籤" onChange={e => setAdding(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') void addTag(); }} />
                            <button type="button" className="bond-btn" onClick={addTag} disabled={!adding.trim()}>加</button>
                        </div>
                    </section>
                )}
                <section>
                    <SectionLabel>紙 條</SectionLabel>
                    <textarea className="bond-input bond-serif min-h-[180px] leading-relaxed" value={text} onChange={e => setText(e.target.value)}
                        placeholder="吐槽、掛念、想一起做的事、當面沒說出口的話……一句也可以" />
                    <div className="mt-1.5 text-[11px] text-[var(--bond-muted)]">投遞了{name}才知道；存成草稿只有你看得到。</div>
                </section>
            </div>
            <div className="shrink-0 px-5 pt-3 border-t bond-hair flex gap-2" style={{ paddingBottom: 'calc(var(--safe-bottom, 0px) + 12px)' }}>
                <button type="button" className="bond-btn flex-1" disabled={busy || !text.trim()} onClick={() => save(false)}>存草稿</button>
                <button type="button" className="bond-btn bond-btn-primary flex-1" disabled={busy || !text.trim()} onClick={() => save(true)}><PaperPlaneTilt size={14} />投遞</button>
            </div>
        </div>
    );
};
