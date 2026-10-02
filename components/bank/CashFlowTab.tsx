import React, { useMemo, useState } from 'react';
import Modal from '../os/Modal';
import type { FinanceFlowCategory, RealBalanceState, RealBalanceTransaction } from '../../types';
import {
    CASH_ACCOUNT, EXPENSE_CATEGORIES, FLOW_CATEGORY_LABELS, INCOME_CATEGORIES,
    accountLabel, addManualFlow, canDeleteFlow, deleteFlow, filterFlows, flowAccountId, flowMonths, flowTotals,
    formatMoneyDisplay, isInternalTransfer,
} from '../../utils/finance';
import { getLocalDateKey } from '../../utils/localDate';
import { ArrowDown, ArrowUp, ArrowsLeftRight } from '@phosphor-icons/react';
import { trackEvent } from '../../utils/analytics';

interface Props {
    state: RealBalanceState;
    onCommit: (next: RealBalanceState) => void;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
    /** ＋ 在頁首（跟 AI ⟳ 放一起），所以開關由外層管 */
    addOpen: boolean;
    setAddOpen: (open: boolean) => void;
}

const SOURCE_BADGE: Record<string, string> = { manual: '手動', auto: '自動', ai: 'AI' };
const monthLabel = (m: string) => `${Number(m.slice(0, 4))} 年 ${Number(m.slice(5, 7))} 月`;

const inputCls = 'w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm';
const labelCls = 'text-[10px] font-bold text-slate-400 block mb-1';

/** 流水 Tab：所有帳戶的收支，按月份／帳戶篩，＋ 手動記一筆。 */
const CashFlowTab: React.FC<Props> = ({ state, onCommit, addToast, addOpen, setAddOpen }) => {
    const months = useMemo(() => flowMonths(state), [state]);
    const [month, setMonth] = useState(months[0]);
    const [account, setAccount] = useState<string>('');
    const [detail, setDetail] = useState<RealBalanceTransaction | null>(null);

    const flows = filterFlows(state, { month, accountId: account || undefined });
    const totals = flowTotals(flows);

    // ── 新增表單 ──
    const [direction, setDirection] = useState<'in' | 'out'>('out');
    const [amount, setAmount] = useState('');
    const [flowAccount, setFlowAccount] = useState<string>(CASH_ACCOUNT);
    const [category, setCategory] = useState<FinanceFlowCategory>('food');
    const [label, setLabel] = useState('');
    const [note, setNote] = useState('');
    const [date, setDate] = useState(getLocalDateKey());
    const resetForm = () => { setAmount(''); setLabel(''); setNote(''); setDate(getLocalDateKey()); };
    const switchDirection = (d: 'in' | 'out') => { setDirection(d); setCategory(d === 'in' ? 'salary' : 'food'); };

    const submit = () => {
        const today = getLocalDateKey();
        // 選今天就記現在；選了別天記那天中午，免得時區把它推到隔壁那天
        const timestamp = date === today ? Date.now() : new Date(`${date}T12:00:00`).getTime();
        const result = addManualFlow(state, {
            direction, amount: parseFloat(amount.replace(/,/g, '')) || 0, accountId: flowAccount, category, label, note,
            timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
        });
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        onCommit(result.state);
        trackEvent('手动记一笔流水', { 方向: direction === 'in' ? '收入' : '支出' });
        setAddOpen(false);
        resetForm();
        addToast('已記一筆', 'success');
    };

    const remove = (tx: RealBalanceTransaction) => {
        const result = deleteFlow(state, tx.id);
        if (!result.ok) { addToast(result.reason, 'error'); return; }
        onCommit(result.state);
        setDetail(null);
        addToast(tx.source === 'manual' ? '已刪除，金額已退回' : '已刪除', 'success');
    };

    const categories = direction === 'in' ? INCOME_CATEGORIES : EXPENSE_CATEGORIES;

    return (
        <div className="space-y-3">
            {/* 篩選 */}
            <div className="flex gap-2">
                <select value={month} onChange={e => setMonth(e.target.value)} className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600">
                    {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                </select>
                <select value={account} onChange={e => setAccount(e.target.value)} className="flex-1 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs font-bold text-slate-600">
                    <option value="">全部帳戶</option>
                    <option value={CASH_ACCOUNT}>現金</option>
                    {state.cards.map(c => <option key={c.id} value={c.id}>{accountLabel(state, c.id)}</option>)}
                </select>
            </div>

            {/* 月度合計 */}
            <div className="grid grid-cols-2 gap-2">
                <div className="bg-white rounded-2xl border border-slate-100 px-4 py-3">
                    <div className="text-[10px] text-slate-400">收入</div>
                    <div className="text-base font-black text-emerald-500 tabular-nums">{formatMoneyDisplay(totals.income)}</div>
                </div>
                <div className="bg-white rounded-2xl border border-slate-100 px-4 py-3">
                    <div className="text-[10px] text-slate-400">支出</div>
                    <div className="text-base font-black text-rose-500 tabular-nums">{formatMoneyDisplay(totals.expense)}</div>
                </div>
            </div>

            {/* 列表 */}
            <div className="bg-white rounded-[1.5rem] shadow-[0_10px_30px_-14px_rgba(80,70,120,0.2)] border border-slate-100 py-1">
                {flows.length === 0 && <div className="text-center text-xs text-slate-400 py-8">這個月還沒有流水</div>}
                {flows.map(tx => {
                    const transfer = isInternalTransfer(tx);
                    const positive = tx.amount >= 0;
                    const meta = [
                        new Date(tx.timestamp).toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }),
                        transfer && tx.cardId ? `現金 ${positive ? '←' : '→'} ${accountLabel(state, tx.cardId)}` : accountLabel(state, flowAccountId(tx)),
                        tx.category && !transfer ? FLOW_CATEGORY_LABELS[tx.category] : '',
                    ].filter(Boolean).join(' · ');
                    return (
                        <button key={tx.id} onClick={() => setDetail(tx)} className="w-full flex items-center gap-3 px-4 py-2.5 text-left active:bg-slate-50">
                            <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${transfer ? 'bg-slate-100 text-slate-400' : positive ? 'bg-emerald-50 text-emerald-500' : 'bg-rose-50 text-rose-500'}`}>
                                {transfer ? <ArrowsLeftRight size={14} weight="bold" /> : positive ? <ArrowDown size={14} weight="bold" /> : <ArrowUp size={14} weight="bold" />}
                            </div>
                            <div className="min-w-0 flex-1">
                                <div className="flex items-center gap-1.5">
                                    <span className="text-xs font-bold text-slate-700 truncate">{tx.label}</span>
                                    {tx.source && <span className="text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-400 shrink-0">{SOURCE_BADGE[tx.source]}</span>}
                                </div>
                                <div className="text-[10px] text-slate-400 truncate mt-0.5">{meta}</div>
                            </div>
                            <div className="text-right shrink-0">
                                <div className={`text-xs font-bold tabular-nums ${transfer ? 'text-slate-500' : positive ? 'text-emerald-500' : 'text-rose-500'}`}>
                                    {positive ? '+' : '−'}{formatMoneyDisplay(Math.abs(tx.amount))}
                                </div>
                                {tx.source !== 'ai' && <div className="text-[10px] text-slate-400 tabular-nums">餘 {formatMoneyDisplay(tx.balanceAfter)}</div>}
                            </div>
                        </button>
                    );
                })}
            </div>

            {/* 一筆的詳情 */}
            <Modal isOpen={!!detail} title={detail?.label || ''} onClose={() => setDetail(null)}
                footer={detail && canDeleteFlow(detail) ? (
                    <div className="flex gap-3 w-full">
                        <button onClick={() => setDetail(null)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">關閉</button>
                        <button onClick={() => detail && remove(detail)} className="flex-1 py-3 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">刪除這筆</button>
                    </div>
                ) : undefined}>
                {detail && (
                    <div className="space-y-2 text-xs text-slate-600">
                        <div className={`text-2xl font-black tabular-nums ${detail.amount >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
                            {detail.amount >= 0 ? '+' : '−'}{formatMoneyDisplay(Math.abs(detail.amount))}
                        </div>
                        <div>{new Date(detail.timestamp).toLocaleString('zh-TW', { hour12: false })}</div>
                        <div>帳戶：{accountLabel(state, flowAccountId(detail))}</div>
                        {detail.category && <div>分類：{FLOW_CATEGORY_LABELS[detail.category]}</div>}
                        {detail.detail && <div className="text-slate-500 whitespace-pre-wrap">{detail.detail}</div>}
                        <p className="text-[10px] text-slate-400 pt-2">
                            {detail.source === 'manual' ? '手動記的。刪掉會把金額退回帳戶。'
                                : detail.source === 'ai' ? 'AI 生成的過去紀錄，當初沒有動到餘額，刪掉也不會。'
                                : detail.source === 'auto' ? '固定收支自動記的帳，不能刪。'
                                : '聊天或互轉記的帳，是真的發生過的事，不能刪。'}
                        </p>
                    </div>
                )}
            </Modal>

            {/* 手動記一筆 */}
            <Modal isOpen={addOpen} title="記一筆" onClose={() => setAddOpen(false)}
                footer={<button onClick={submit} className="w-full py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">保存</button>}>
                <div className="space-y-4">
                    <div className="grid grid-cols-2 gap-2 p-1 bg-slate-100 rounded-2xl">
                        {(['out', 'in'] as const).map(d => (
                            <button key={d} onClick={() => switchDirection(d)}
                                className={`py-2 rounded-xl text-xs font-bold transition-colors ${direction === d ? (d === 'in' ? 'bg-white text-emerald-600 shadow-sm' : 'bg-white text-rose-500 shadow-sm') : 'text-slate-400'}`}>
                                {d === 'in' ? '收入' : '支出'}
                            </button>
                        ))}
                    </div>
                    <div>
                        <label className={labelCls}>金額</label>
                        <input value={amount} onChange={e => setAmount(e.target.value)} placeholder="0" inputMode="decimal" className={`${inputCls} text-lg font-bold`} />
                    </div>
                    <div>
                        <label className={labelCls}>分類</label>
                        <div className="flex flex-wrap gap-1.5">
                            {categories.map(c => (
                                <button key={c} onClick={() => setCategory(c)}
                                    className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors ${category === c ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
                                    {FLOW_CATEGORY_LABELS[c]}
                                </button>
                            ))}
                        </div>
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                        <div>
                            <label className={labelCls}>{direction === 'in' ? '進到' : '從哪付'}</label>
                            <select value={flowAccount} onChange={e => setFlowAccount(e.target.value)} className={inputCls}>
                                <option value={CASH_ACCOUNT}>現金</option>
                                {state.cards.map(c => <option key={c.id} value={c.id}>{accountLabel(state, c.id)}</option>)}
                            </select>
                        </div>
                        <div>
                            <label className={labelCls}>日期</label>
                            <input type="date" value={date} max={getLocalDateKey()} onChange={e => setDate(e.target.value || getLocalDateKey())} className={inputCls} />
                        </div>
                    </div>
                    <div>
                        <label className={labelCls}>名稱</label>
                        <input value={label} onChange={e => setLabel(e.target.value)} placeholder={FLOW_CATEGORY_LABELS[category]} className={inputCls} />
                    </div>
                    <div>
                        <label className={labelCls}>備註</label>
                        <input value={note} onChange={e => setNote(e.target.value)} placeholder="可不填" className={inputCls} />
                    </div>
                    <p className="text-[10px] text-slate-400">存了就會真的動到這個帳戶的餘額，Net Worth 跟著變。</p>
                </div>
            </Modal>
        </div>
    );
};

export default CashFlowTab;
