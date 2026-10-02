import React, { useState } from 'react';
import type { RealBalanceState } from '../../types';
import {
    INCOME_KIND_LABELS, INVESTMENT_KIND_LABELS, LIABILITY_KIND_LABELS, PROPERTY_MODE_LABELS, VEHICLE_KIND_LABELS,
    accountLabel, computeNetWorth, financeBook, formatMoneyDisplay, monthlySummary, removeFinanceItem, rentalIncomes,
    upsertFinanceItem, type FinanceBlockKey,
} from '../../utils/finance';
import { Briefcase, ChartLineUp, House, Car, HandCoins, Package, Receipt } from '@phosphor-icons/react';
import CashCardsBlocks from './CashCardsBlocks';
import { BlockRow, BlockShell, EmptyRow } from './FinanceBlockShell';
import FinanceItemEditor, { BLOCK_TITLES, type FinanceEditTarget } from './FinanceItemEditor';
import { trackEvent } from '../../utils/analytics';

/** 埋點用的區塊名：寫死的簡體字面量（見 docs/analytics.md），不從畫面文字轉 */
const BLOCK_ANALYTICS: Record<FinanceBlockKey, string> = {
    incomes: '收入', expenses: '固定支出', investments: '投资', properties: '房产', vehicles: '交通工具', liabilities: '负债', others: '其他',
};

interface Props {
    state: RealBalanceState;
    onCommit: (next: RealBalanceState) => void;
    addToast: (message: string, type?: 'info' | 'success' | 'error') => void;
}

const day = (d?: number) => (d ? `每月 ${d} 號` : '');
const pct = (cost: number, value: number) => {
    if (!(cost > 0)) return '';
    const p = ((value - cost) / cost) * 100;
    return `${p >= 0 ? '+' : ''}${p.toFixed(1)}%`;
};

/** 總覽 Tab：Net Worth 大卡＋各 block。設計見 plans/finance-wallet-design.md。 */
const FinanceOverview: React.FC<Props> = ({ state, onCommit, addToast }) => {
    const [editing, setEditing] = useState<FinanceEditTarget | null>(null);
    const book = financeBook(state);
    const nw = computeNetWorth(state);
    const month = monthlySummary(state);
    const rentals = rentalIncomes(state);

    const save = (target: FinanceEditTarget) => {
        if (!target.item) return;
        onCommit(upsertFinanceItem(state, target.block, target.item as never));
        trackEvent('保存余额管理项目', { 区块: BLOCK_ANALYTICS[target.block] });
        setEditing(null);
        addToast(`已保存${BLOCK_TITLES[target.block]}`, 'success');
    };
    const remove = (block: FinanceBlockKey, id: string) => {
        onCommit(removeFinanceItem(state, block, id));
        setEditing(null);
        addToast('已刪除', 'success');
    };

    return (
        <div className="space-y-3">
            {/* Net Worth */}
            <div className="rounded-[1.75rem] p-5 text-white shadow-[0_16px_36px_-18px_rgba(30,41,90,0.6)]"
                style={{ background: 'linear-gradient(140deg, #1e293b 0%, #312e81 60%, #4c1d95 100%)' }}>
                <div className="text-[10px] font-bold tracking-[0.25em] text-white/50">NET WORTH</div>
                <div className={`text-[28px] font-black mt-1 tabular-nums ${nw.netWorth < 0 ? 'text-rose-300' : ''}`}>{formatMoneyDisplay(nw.netWorth)}</div>
                <div className="flex gap-4 mt-2 text-[11px] text-white/60 tabular-nums">
                    <span>資產 {formatMoneyDisplay(nw.assets)}</span>
                    <span>負債 <span className={nw.liabilities > 0 ? 'text-rose-300' : ''}>{nw.liabilities > 0 ? '−' : ''}{formatMoneyDisplay(nw.liabilities)}</span></span>
                </div>
                <div className="mt-3 pt-3 border-t border-white/10 flex gap-4 text-[11px] text-white/70 tabular-nums">
                    <span>月收入 {formatMoneyDisplay(month.income)}</span>
                    <span>月固定支出 {formatMoneyDisplay(month.fixedOut)}</span>
                </div>
            </div>

            {/* 收入 */}
            <BlockShell icon={<Briefcase size={16} weight="fill" />} title="收入" total={month.income} onAdd={() => setEditing({ block: 'incomes' })}>
                {book.incomes.length === 0 && rentals.length === 0 && <EmptyRow />}
                {book.incomes.map(it => (
                    <BlockRow key={it.id} title={it.name}
                        sub={[INCOME_KIND_LABELS[it.kind], it.recurring ? `${day(it.recurring.dayOfMonth)}入帳到${accountLabel(state, it.recurring.accountId)}` : '不固定'].join(' · ')}
                        amount={it.amount} amountSub={it.recurring ? '每月' : '大約'}
                        onClick={() => setEditing({ block: 'incomes', item: it })} />
                ))}
                {rentals.map(r => (
                    <BlockRow key={r.propertyId} title={r.name} sub={[day(r.dayOfMonth), '從房產帶過來'].filter(Boolean).join(' · ')} amount={r.amount} amountSub="每月" badge="房產"
                        onClick={() => { const p = book.properties.find(x => x.id === r.propertyId); if (p) setEditing({ block: 'properties', item: p }); }} />
                ))}
            </BlockShell>

            {/* 固定支出 */}
            <BlockShell icon={<Receipt size={16} weight="fill" />} title="固定支出" total={book.expenses.reduce((sum, e) => sum + e.amount, 0)} onAdd={() => setEditing({ block: 'expenses' })}>
                {book.expenses.length === 0 && <EmptyRow text="生活費、電話費這類每月都要付的" />}
                {book.expenses.map(it => (
                    <BlockRow key={it.id} title={it.name}
                        sub={it.recurring ? `${day(it.recurring.dayOfMonth)}從${accountLabel(state, it.recurring.accountId)}扣` : (it.note || '手動付')}
                        amount={it.amount} amountSub="每月" tone="muted"
                        onClick={() => setEditing({ block: 'expenses', item: it })} />
                ))}
            </BlockShell>

            <CashCardsBlocks state={state} onCommit={onCommit} addToast={addToast} />

            {/* 投資 */}
            <BlockShell icon={<ChartLineUp size={16} weight="fill" />} title="投資" total={nw.investments} onAdd={() => setEditing({ block: 'investments' })}>
                {book.investments.length === 0 && <EmptyRow />}
                {book.investments.map(it => (
                    <BlockRow key={it.id} title={it.name}
                        sub={[INVESTMENT_KIND_LABELS[it.kind], it.contribution ? `${day(it.contribution.dayOfMonth)}扣 ${formatMoneyDisplay(it.contribution.amount)}` : ''].filter(Boolean).join(' · ')}
                        amount={it.value} amountSub={it.cost > 0 ? `成本 ${formatMoneyDisplay(it.cost)} ${pct(it.cost, it.value)}` : undefined}
                        onClick={() => setEditing({ block: 'investments', item: it })} />
                ))}
            </BlockShell>

            {/* 房產 */}
            <BlockShell icon={<House size={16} weight="fill" />} title="房產" total={nw.properties} onAdd={() => setEditing({ block: 'properties' })}>
                {book.properties.length === 0 && <EmptyRow />}
                {book.properties.map(it => {
                    const lease = it.lease;
                    const leaseText = lease ? [
                        `月租 ${formatMoneyDisplay(lease.monthlyRent)}`,
                        lease.recurring ? `${day(lease.recurring.dayOfMonth)}${it.mode === 'own-rent' ? '收' : '交'}` : '',
                        lease.leaseEnd ? `租約到 ${lease.leaseEnd}` : '',
                    ].filter(Boolean).join(' · ') : '';
                    return (
                        <BlockRow key={it.id} title={it.name} badge={PROPERTY_MODE_LABELS[it.mode]}
                            sub={leaseText || it.note}
                            amount={it.mode === 'renting' ? lease?.monthlyRent : it.value}
                            amountSub={it.mode === 'renting' ? '每月房租' : undefined}
                            tone={it.mode === 'renting' ? 'muted' : 'normal'}
                            onClick={() => setEditing({ block: 'properties', item: it })} />
                    );
                })}
            </BlockShell>

            {/* 交通工具 */}
            <BlockShell icon={<Car size={16} weight="fill" />} title="交通工具" total={nw.vehicles} onAdd={() => setEditing({ block: 'vehicles' })}>
                {book.vehicles.length === 0 && <EmptyRow />}
                {book.vehicles.map(it => (
                    <BlockRow key={it.id} title={it.model} sub={[VEHICLE_KIND_LABELS[it.kind], it.note].filter(Boolean).join(' · ')} amount={it.value}
                        onClick={() => setEditing({ block: 'vehicles', item: it })} />
                ))}
            </BlockShell>

            {/* 負債 */}
            <BlockShell icon={<HandCoins size={16} weight="fill" />} title="負債" total={nw.liabilities} negative onAdd={() => setEditing({ block: 'liabilities' })}>
                {book.liabilities.length === 0 && <EmptyRow text="沒有負債" />}
                {book.liabilities.map(it => (
                    <BlockRow key={it.id} title={it.name} badge={LIABILITY_KIND_LABELS[it.kind]}
                        sub={[
                            it.monthlyPayment ? `每月還 ${formatMoneyDisplay(it.monthlyPayment)}` : '',
                            it.recurring ? `${it.recurring.dayOfMonth} 號扣` : '',
                            it.remainingTerms ? `還剩 ${it.remainingTerms} 期` : '',
                            it.creditLimit ? `額度 ${formatMoneyDisplay(it.creditLimit)}` : '',
                        ].filter(Boolean).join(' · ') || it.note}
                        amount={it.owed} tone="negative"
                        onClick={() => setEditing({ block: 'liabilities', item: it })} />
                ))}
            </BlockShell>

            {/* 其他 */}
            <BlockShell icon={<Package size={16} weight="fill" />} title="其他" total={nw.others} onAdd={() => setEditing({ block: 'others' })}>
                {book.others.length === 0 && <EmptyRow />}
                {book.others.map(it => (
                    <BlockRow key={it.id} title={it.name} sub={it.note} amount={it.value}
                        onClick={() => setEditing({ block: 'others', item: it })} />
                ))}
            </BlockShell>

            <FinanceItemEditor target={editing} state={state} onSave={save} onDelete={remove} onClose={() => setEditing(null)} />
        </div>
    );
};

export default FinanceOverview;
