import React, { useState } from 'react';
import { ArrowCounterClockwise, BookOpenText, Check, Eye, PaintBrush, SlidersHorizontal, SquaresFour, X } from '@phosphor-icons/react';
import type { AssistantCssProposal, AssistantProposal } from '../../types';

/**
 * Sore 的提案卡片（plans/ai-assistant.md 第 3 節）：改哪裡、改成什麼，按「套用」才寫；
 * 套用後變成「已套用 · 還原」。美化 CSS 預設收起來，想看再展開；預設列出每個改動，有改前改後的可以展開。
 */
interface Props {
    proposal: AssistantProposal;
    busy?: boolean;
    onApply: () => void;
    onReject: () => void;
    onRestore: () => void;
    /** 有假資料頁的美化位置、小組件才有（見面、預設、世界書沒有） */
    onPreview?: () => void;
}

const STATUS_LABEL: Record<AssistantProposal['status'], string> = {
    pending: '等你決定',
    applied: '已套用',
    rejected: '不要了',
    restored: '已還原',
};

const lineCount = (css: string) => (css.trim() ? css.trim().split('\n').length : 0);

const CssBody: React.FC<{ proposal: AssistantCssProposal }> = ({ proposal }) => {
    const [open, setOpen] = useState<'none' | 'after' | 'before'>('none');
    const clearing = !proposal.css.trim();
    const shown = open === 'after' ? proposal.css : proposal.before;
    return (
        <>
            <div className="text-[11px] text-slate-500 -mt-1 pl-6">
                {clearing ? '清空這裡的 CSS' : proposal.summary || 'CSS 改寫'}
                {' · '}{lineCount(proposal.before)} → {lineCount(proposal.css)} 行
            </div>
            <div className="flex gap-3 text-[11px]">
                {!clearing && (
                    <button type="button" className="text-amber-700 underline-offset-2 hover:underline" onClick={() => setOpen(open === 'after' ? 'none' : 'after')}>
                        {open === 'after' ? '收起' : '看新的 CSS'}
                    </button>
                )}
                {!!proposal.before.trim() && (
                    <button type="button" className="text-slate-500 underline-offset-2 hover:underline" onClick={() => setOpen(open === 'before' ? 'none' : 'before')}>
                        {open === 'before' ? '收起' : '看原本的'}
                    </button>
                )}
            </div>
            {open !== 'none' && (
                <pre className="max-h-56 overflow-auto rounded-xl bg-slate-900 text-slate-100 p-2.5 text-[10.5px] leading-relaxed whitespace-pre-wrap break-all" data-sore-proposal-css>{shown}</pre>
            )}
        </>
    );
};

/** 預設、世界書共用：一行一個改動，有改前改後的可以展開 */
const ChangesBody: React.FC<{ proposal: { summary?: string; usage?: string[]; changes: Array<{ label: string; before?: string; after?: string }> } }> = ({ proposal }) => {
    const [open, setOpen] = useState<number | null>(null);
    return (
        <>
            {proposal.summary && <div className="text-[11px] text-slate-500 -mt-1 pl-6">{proposal.summary}</div>}
            {!!proposal.usage?.length && (
                <div className="rounded-lg bg-amber-50 px-2.5 py-1.5 text-[11px] text-amber-800" data-sore-preset-usage>
                    這份正在被 {proposal.usage.join('、')} 用，改了這些地方都會跟著變
                </div>
            )}
            <ul className="space-y-1" data-sore-preset-changes>
                {proposal.changes.map((change, i) => {
                    const expandable = change.before !== undefined || change.after !== undefined;
                    return (
                        <li key={i} className="text-[12px] leading-snug">
                            <div className="flex items-start gap-1.5">
                                <span className="text-slate-300">•</span>
                                <span className="flex-1 min-w-0 break-words">{change.label}</span>
                                {expandable && (
                                    <button type="button" className="shrink-0 text-[11px] text-amber-700" onClick={() => setOpen(open === i ? null : i)}>
                                        {open === i ? '收起' : '看'}
                                    </button>
                                )}
                            </div>
                            {open === i && (
                                <div className="mt-1 space-y-1">
                                    {change.before !== undefined && (
                                        <pre className="max-h-40 overflow-auto rounded-lg bg-rose-50 text-rose-900 p-2 text-[10.5px] leading-relaxed whitespace-pre-wrap break-words"><span className="font-bold">改之前　</span>{change.before || '（空白）'}</pre>
                                    )}
                                    {change.after !== undefined && (
                                        <pre className="max-h-40 overflow-auto rounded-lg bg-emerald-50 text-emerald-900 p-2 text-[10.5px] leading-relaxed whitespace-pre-wrap break-words"><span className="font-bold">改之後　</span>{change.after || '（空白）'}</pre>
                                    )}
                                </div>
                            )}
                        </li>
                    );
                })}
            </ul>
        </>
    );
};

const ProposalCard: React.FC<Props> = ({ proposal, busy, onApply, onReject, onRestore, onPreview }) => {
    const tone = proposal.status === 'applied' ? 'border-emerald-200 bg-emerald-50/60'
        : proposal.status === 'pending' ? 'border-amber-200 bg-white' : 'border-slate-200 bg-slate-50';
    const btn = 'flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-bold transition active:scale-95 disabled:opacity-40';
    const Icon = proposal.kind === 'preset' ? SlidersHorizontal : proposal.kind === 'worldbook' ? BookOpenText : proposal.kind === 'widget' ? SquaresFour : PaintBrush;

    return (
        <div className={`rounded-2xl border ${tone} shadow-sm px-3.5 py-3 space-y-2`} data-sore-proposal data-kind={proposal.kind} data-status={proposal.status}>
            <div className="flex items-start gap-2">
                <Icon size={16} weight="fill" className="mt-0.5 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1 text-[13px] font-bold leading-snug">{proposal.targetLabel}</div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${proposal.status === 'applied' ? 'bg-emerald-100 text-emerald-700' : proposal.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-500'}`}>
                    {STATUS_LABEL[proposal.status]}
                </span>
            </div>

            {proposal.kind === 'css' ? <CssBody proposal={proposal} /> : <ChangesBody proposal={proposal} />}

            <div className="flex flex-wrap gap-2 pt-0.5">
                {onPreview && (
                    <button type="button" onClick={onPreview} className={`${btn} bg-white border border-amber-200 text-amber-700`}>
                        <Eye size={13} weight="bold" /> 預覽
                    </button>
                )}
                {proposal.status === 'applied' ? (
                    <button type="button" disabled={busy} onClick={onRestore} className={`${btn} bg-white border border-slate-200 text-slate-600`}>
                        <ArrowCounterClockwise size={13} weight="bold" /> 還原
                    </button>
                ) : (
                    <>
                        <button type="button" disabled={busy} onClick={onApply} className={`${btn} bg-amber-400 text-white`}>
                            <Check size={13} weight="bold" /> {proposal.status === 'pending' ? '套用' : '還是套用'}
                        </button>
                        {proposal.status === 'pending' && (
                            <button type="button" disabled={busy} onClick={onReject} className={`${btn} bg-white border border-slate-200 text-slate-500`}>
                                <X size={13} weight="bold" /> 不要
                            </button>
                        )}
                    </>
                )}
            </div>
        </div>
    );
};

export default ProposalCard;
