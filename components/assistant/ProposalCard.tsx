import React, { useState } from 'react';
import { ArrowCounterClockwise, Check, PaintBrush, X } from '@phosphor-icons/react';
import type { AssistantProposal } from '../../types';

/**
 * Sore 的提案卡片（plans/ai-assistant.md 第 3 節）：改哪裡、改成什麼，按「套用」才寫；
 * 套用後變成「已套用 · 還原」。CSS 預設收起來，想看再展開。
 */
interface Props {
    proposal: AssistantProposal;
    busy?: boolean;
    onApply: () => void;
    onReject: () => void;
    onRestore: () => void;
}

const STATUS_LABEL: Record<AssistantProposal['status'], string> = {
    pending: '等你決定',
    applied: '已套用',
    rejected: '不要了',
    restored: '已還原',
};

const lineCount = (css: string) => (css.trim() ? css.trim().split('\n').length : 0);

const ProposalCard: React.FC<Props> = ({ proposal, busy, onApply, onReject, onRestore }) => {
    const [open, setOpen] = useState<'none' | 'after' | 'before'>('none');
    const clearing = !proposal.css.trim();
    const tone = proposal.status === 'applied' ? 'border-emerald-200 bg-emerald-50/60'
        : proposal.status === 'pending' ? 'border-amber-200 bg-white' : 'border-slate-200 bg-slate-50';
    const btn = 'flex items-center gap-1 rounded-full px-3 py-1.5 text-[12px] font-bold transition active:scale-95 disabled:opacity-40';
    const shown = open === 'after' ? proposal.css : proposal.before;

    return (
        <div className={`rounded-2xl border ${tone} shadow-sm px-3.5 py-3 space-y-2`} data-sore-proposal data-status={proposal.status}>
            <div className="flex items-start gap-2">
                <PaintBrush size={16} weight="fill" className="mt-0.5 shrink-0 text-amber-500" />
                <div className="min-w-0 flex-1">
                    <div className="text-[13px] font-bold leading-snug">{proposal.targetLabel}</div>
                    <div className="text-[11px] text-slate-500">
                        {clearing ? '清空這裡的 CSS' : proposal.summary || 'CSS 改寫'}
                        {' · '}{lineCount(proposal.before)} → {lineCount(proposal.css)} 行
                    </div>
                </div>
                <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-bold ${proposal.status === 'applied' ? 'bg-emerald-100 text-emerald-700' : proposal.status === 'pending' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-500'}`}>
                    {STATUS_LABEL[proposal.status]}
                </span>
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

            <div className="flex flex-wrap gap-2 pt-0.5">
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
