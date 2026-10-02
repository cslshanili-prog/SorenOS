import React from 'react';
import { CaretRight, Plus } from '@phosphor-icons/react';
import { formatMoneyDisplay as formatMoney } from '../../utils/finance';

/** 總覽的一塊：標題列（圖示、名稱、小計、＋）＋內容。 */
export const BlockShell: React.FC<{
    icon: React.ReactNode;
    title: string;
    total?: number;
    /** 負債那塊小計顯示成紅色、帶負號 */
    negative?: boolean;
    onAdd?: () => void;
    children: React.ReactNode;
}> = ({ icon, title, total, negative, onAdd, children }) => (
    <section className="bg-white rounded-[1.5rem] shadow-[0_10px_30px_-14px_rgba(80,70,120,0.2)] border border-slate-100 overflow-hidden">
        <div className="flex items-center gap-2 px-4 pt-3.5 pb-2.5">
            <span className="w-7 h-7 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">{icon}</span>
            <span className="text-[13px] font-bold text-slate-700 flex-1">{title}</span>
            {total !== undefined && (
                <span className={`text-[13px] font-bold tabular-nums ${negative && total > 0 ? 'text-rose-500' : 'text-slate-700'}`}>
                    {negative && total > 0 ? '−' : ''}{formatMoney(total)}
                </span>
            )}
            {onAdd && (
                <button onClick={onAdd} className="w-7 h-7 rounded-full bg-sky-50 text-sky-500 flex items-center justify-center active:scale-90 transition-transform shrink-0" aria-label={`新增${title}`}>
                    <Plus size={14} weight="bold" />
                </button>
            )}
        </div>
        {children}
    </section>
);

/** block 裡的一列：左邊名稱＋說明，右邊金額＋小字；可點就帶箭頭。 */
export const BlockRow: React.FC<{
    title: string;
    sub?: string;
    amount?: number;
    amountSub?: string;
    tone?: 'normal' | 'negative' | 'muted';
    badge?: string;
    onClick?: () => void;
}> = ({ title, sub, amount, amountSub, tone = 'normal', badge, onClick }) => (
    <button onClick={onClick} disabled={!onClick} className="w-full flex items-center gap-3 px-4 py-2.5 text-left border-t border-slate-50 active:bg-slate-50 disabled:active:bg-transparent">
        <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
                <span className="text-xs font-bold text-slate-700 truncate">{title}</span>
                {badge && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-sky-50 text-sky-500 shrink-0">{badge}</span>}
            </div>
            {sub && <div className="text-[10px] text-slate-400 truncate mt-0.5">{sub}</div>}
        </div>
        {amount !== undefined && (
            <div className="text-right shrink-0">
                <div className={`text-xs font-bold tabular-nums ${tone === 'negative' ? 'text-rose-500' : tone === 'muted' ? 'text-slate-400' : 'text-slate-700'}`}>
                    {tone === 'negative' && amount > 0 ? '−' : ''}{formatMoney(amount)}
                </div>
                {amountSub && <div className="text-[10px] text-slate-400 tabular-nums">{amountSub}</div>}
            </div>
        )}
        {onClick && <CaretRight size={12} className="text-slate-300 shrink-0" />}
    </button>
);

export const EmptyRow: React.FC<{ text?: string }> = ({ text = '還沒有' }) => (
    <div className="px-4 pb-3.5 text-[11px] text-slate-400">{text}</div>
);
