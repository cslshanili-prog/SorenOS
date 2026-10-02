import React, { useEffect, useState } from 'react';
import Modal from '../os/Modal';
import type {
    FinanceIncomeItem, FinanceInvestmentItem, FinanceLiabilityItem, FinanceOtherItem, FinancePropertyItem,
    FinanceRecurring, FinanceVehicleItem, RealBalanceState,
} from '../../types';
import {
    CASH_ACCOUNT, INCOME_KIND_LABELS, INVESTMENT_KIND_LABELS, LIABILITY_KIND_LABELS, PROPERTY_MODE_LABELS,
    VEHICLE_KIND_LABELS, accountLabel, makeFinanceId, withRecurringStart, type FinanceBlockKey,
} from '../../utils/finance';

export type FinanceEditTarget =
    | { block: 'incomes'; item?: FinanceIncomeItem }
    | { block: 'investments'; item?: FinanceInvestmentItem }
    | { block: 'properties'; item?: FinancePropertyItem }
    | { block: 'vehicles'; item?: FinanceVehicleItem }
    | { block: 'liabilities'; item?: FinanceLiabilityItem }
    | { block: 'others'; item?: FinanceOtherItem };

export const BLOCK_TITLES: Record<FinanceBlockKey, string> = {
    incomes: '收入', investments: '投資', properties: '房產', vehicles: '交通工具', liabilities: '負債', others: '其他',
};

const inputCls = 'w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm';
const labelCls = 'text-[10px] font-bold text-slate-400 block mb-1';

const num = (v: string): number => {
    const n = parseFloat(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : 0;
};
const str = (n: number | undefined): string => (n === undefined || n === null ? '' : String(n));

const Field: React.FC<{ label: string; hint?: string; children: React.ReactNode }> = ({ label, hint, children }) => (
    <div>
        <div className="flex items-center justify-between">
            <label className={labelCls}>{label}</label>
            {hint && <span className="text-[9px] text-slate-300 mb-1">{hint}</span>}
        </div>
        {children}
    </div>
);

function Chips<T extends string>({ value, options, onChange }: { value: T; options: Record<T, string>; onChange: (v: T) => void }) {
    return (
        <div className="flex flex-wrap gap-1.5">
            {(Object.keys(options) as T[]).map(k => (
                <button key={k} type="button" onClick={() => onChange(k)}
                    className={`px-3 py-1.5 rounded-full text-[11px] font-bold transition-colors ${value === k ? 'bg-slate-800 text-white' : 'bg-slate-100 text-slate-500'}`}>
                    {options[k]}
                </button>
            ))}
        </div>
    );
}

const Toggle: React.FC<{ checked: boolean; onChange: (v: boolean) => void; label: string; sub?: string }> = ({ checked, onChange, label, sub }) => (
    <button type="button" onClick={() => onChange(!checked)} className="w-full flex items-center justify-between gap-3 py-1 text-left">
        <span>
            <span className="block text-xs font-bold text-slate-700">{label}</span>
            {sub && <span className="block text-[10px] text-slate-400 mt-0.5">{sub}</span>}
        </span>
        <span className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${checked ? 'bg-sky-500' : 'bg-slate-200'}`}>
            <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-4' : ''}`} />
        </span>
    </button>
);

/** 每月幾號＋哪個帳戶，固定收支共用。 */
const RecurringFields: React.FC<{ state: RealBalanceState; day: string; account: string; onDay: (v: string) => void; onAccount: (v: string) => void; verb: string }> =
    ({ state, day, account, onDay, onAccount, verb }) => (
        <div className="grid grid-cols-2 gap-3">
            <Field label="每月幾號">
                <select value={day} onChange={e => onDay(e.target.value)} className={inputCls}>
                    {Array.from({ length: 31 }, (_, i) => i + 1).map(d => <option key={d} value={d}>{d} 號</option>)}
                </select>
            </Field>
            <Field label={verb}>
                <select value={account} onChange={e => onAccount(e.target.value)} className={inputCls}>
                    <option value={CASH_ACCOUNT}>現金</option>
                    {state.cards.map(c => <option key={c.id} value={c.id}>{accountLabel(state, c.id)}</option>)}
                    {account !== CASH_ACCOUNT && !state.cards.some(c => c.id === account) && <option value={account}>已刪除的卡</option>}
                </select>
            </Field>
        </div>
    );

interface Props {
    target: FinanceEditTarget | null;
    state: RealBalanceState;
    onSave: (target: FinanceEditTarget) => void;
    onDelete: (block: FinanceBlockKey, id: string) => void;
    onClose: () => void;
}

/**
 * 總覽各 block 的新增／編輯彈窗。表單先用字串存（輸入框好處理），保存時才組回型別；
 * 固定收支的起點交給 utils/finance.ts 的 withRecurringStart，編輯時保留原本的記帳進度。
 */
const FinanceItemEditor: React.FC<Props> = ({ target, state, onSave, onDelete, onClose }) => {
    const [f, setF] = useState<Record<string, string>>({});
    const [auto, setAuto] = useState(false);
    const [confirmDelete, setConfirmDelete] = useState(false);
    const set = (k: string) => (v: string) => setF(prev => ({ ...prev, [k]: v }));

    useEffect(() => {
        setConfirmDelete(false);
        if (!target) return;
        const it: any = target.item || {};
        const rec: FinanceRecurring | undefined = it.recurring || it.contribution || it.lease?.recurring;
        setAuto(!!rec);
        setF({
            name: it.name || '', note: it.note || '', model: it.model || '',
            kind: it.kind || ({ incomes: 'salary', investments: 'stock', vehicles: 'car', liabilities: 'loan' } as Record<string, string>)[target.block] || '',
            mode: it.mode || 'own-live',
            amount: str(it.amount ?? it.contribution?.amount), cost: str(it.cost), value: str(it.value),
            owed: str(it.owed), monthlyPayment: str(it.monthlyPayment), remainingTerms: str(it.remainingTerms), creditLimit: str(it.creditLimit),
            monthlyRent: str(it.lease?.monthlyRent), deposit: str(it.lease?.deposit), leaseEnd: it.lease?.leaseEnd || '',
            day: str(rec?.dayOfMonth ?? 25), account: rec?.accountId || CASH_ACCOUNT,
        });
    }, [target]);

    if (!target) return null;
    const editing = !!target.item;
    const title = `${editing ? '編輯' : '新增'}${BLOCK_TITLES[target.block]}`;
    const recurringOf = (prev: FinanceRecurring | undefined): FinanceRecurring | undefined =>
        withRecurringStart(auto ? { dayOfMonth: num(f.day), accountId: f.account || CASH_ACCOUNT } : undefined, prev);
    // 第一次渲染時表單還沒灌值（useEffect 之後才有），欄位一律當可能不存在
    const txt = (k: string) => (f[k] || '').trim();
    const note = txt('note') || undefined;

    const save = () => {
        const id = target.item?.id || makeFinanceId(target.block.slice(0, 3));
        switch (target.block) {
            case 'incomes': {
                if (!txt('name')) return;
                onSave({ block: 'incomes', item: { id, name: txt('name'), kind: f.kind as FinanceIncomeItem['kind'], amount: num(f.amount), recurring: recurringOf(target.item?.recurring), note } });
                return;
            }
            case 'investments': {
                if (!txt('name')) return;
                const prev = target.item?.contribution;
                const rec = recurringOf(prev);
                onSave({ block: 'investments', item: {
                    id, name: txt('name'), kind: f.kind as FinanceInvestmentItem['kind'], cost: num(f.cost), value: num(f.value),
                    contribution: rec && num(f.amount) > 0 ? { ...rec, amount: num(f.amount) } : undefined, note,
                } });
                return;
            }
            case 'properties': {
                if (!txt('name')) return;
                const mode = f.mode as FinancePropertyItem['mode'];
                const hasLease = mode !== 'own-live' && num(f.monthlyRent) > 0;
                onSave({ block: 'properties', item: {
                    id, name: txt('name'), mode, value: mode === 'renting' ? undefined : num(f.value),
                    lease: hasLease ? {
                        monthlyRent: num(f.monthlyRent),
                        deposit: num(f.deposit) || undefined,
                        leaseEnd: f.leaseEnd || undefined,
                        recurring: recurringOf(target.item?.lease?.recurring),
                    } : undefined,
                    note,
                } });
                return;
            }
            case 'vehicles': {
                if (!txt('model')) return;
                onSave({ block: 'vehicles', item: { id, kind: f.kind as FinanceVehicleItem['kind'], model: txt('model'), value: num(f.value), note } });
                return;
            }
            case 'liabilities': {
                if (!txt('name')) return;
                const terms = Math.round(num(f.remainingTerms));
                onSave({ block: 'liabilities', item: {
                    id, name: txt('name'), kind: f.kind as FinanceLiabilityItem['kind'], owed: Math.max(0, num(f.owed)),
                    monthlyPayment: num(f.monthlyPayment) || undefined,
                    remainingTerms: terms > 0 ? terms : undefined,
                    creditLimit: f.kind === 'credit' ? (num(f.creditLimit) || undefined) : undefined,
                    recurring: num(f.monthlyPayment) > 0 ? recurringOf(target.item?.recurring) : undefined,
                    note,
                } });
                return;
            }
            case 'others': {
                if (!txt('name')) return;
                onSave({ block: 'others', item: { id, name: txt('name'), value: num(f.value), note } });
                return;
            }
        }
    };

    const nameField = (placeholder: string) => (
        <Field label="名稱"><input value={f.name || ''} onChange={e => set('name')(e.target.value)} placeholder={placeholder} className={inputCls} /></Field>
    );
    const moneyField = (key: string, label: string, hint?: string) => (
        <Field label={label} hint={hint}><input value={f[key] || ''} onChange={e => set(key)(e.target.value)} placeholder="0" inputMode="decimal" className={inputCls} /></Field>
    );
    const recurring = (label: string, sub: string, verb: string) => (
        <div className="rounded-2xl bg-sky-50/60 border border-sky-100 px-3 py-2 space-y-2">
            <Toggle checked={auto} onChange={setAuto} label={label} sub={sub} />
            {auto && <RecurringFields state={state} day={f.day} account={f.account} onDay={set('day')} onAccount={set('account')} verb={verb} />}
        </div>
    );

    let body: React.ReactNode = null;
    switch (target.block) {
        case 'incomes':
            body = <>
                {nameField('助教月薪、稿費、股息…')}
                <Field label="類型"><Chips value={f.kind as FinanceIncomeItem['kind']} options={INCOME_KIND_LABELS} onChange={set('kind')} /></Field>
                {moneyField('amount', auto ? '每月金額' : '大約金額')}
                {recurring('每月固定入帳', '到了那天自動記一筆收入（打開 App 時補記）', '入帳到')}
            </>;
            break;
        case 'investments':
            body = <>
                {nameField('某某證券、全球指數基金、一幅畫…')}
                <Field label="類型"><Chips value={f.kind as FinanceInvestmentItem['kind']} options={INVESTMENT_KIND_LABELS} onChange={set('kind')} /></Field>
                <div className="grid grid-cols-2 gap-3">{moneyField('cost', '投入成本')}{moneyField('value', '現值', '算 Net Worth 用')}</div>
                {recurring('每月定投', '那天自動扣款，成本與現值一起加上去', '從哪扣')}
                {auto && moneyField('amount', '每月扣多少')}
            </>;
            break;
        case 'properties': {
            const mode = f.mode as FinancePropertyItem['mode'];
            body = <>
                {nameField('文京區公寓、老家透天…')}
                <Field label="方式"><Chips value={mode} options={PROPERTY_MODE_LABELS} onChange={set('mode')} /></Field>
                {mode !== 'renting' && moneyField('value', '價值')}
                {mode !== 'own-live' && <>
                    <div className="grid grid-cols-2 gap-3">{moneyField('monthlyRent', '月租')}{moneyField('deposit', '押金')}</div>
                    <Field label="租約到期"><input type="date" value={f.leaseEnd || ''} onChange={e => set('leaseEnd')(e.target.value)} className={inputCls} /></Field>
                    {recurring(mode === 'own-rent' ? '每月自動收租' : '每月自動交租', mode === 'own-rent' ? '租金會列在「收入」裡' : '到了那天自動扣房租', mode === 'own-rent' ? '收到' : '從哪扣')}
                </>}
            </>;
            break;
        }
        case 'vehicles':
            body = <>
                <Field label="類型"><Chips value={f.kind as FinanceVehicleItem['kind']} options={VEHICLE_KIND_LABELS} onChange={set('kind')} /></Field>
                <Field label="型號"><input value={f.model || ''} onChange={e => set('model')(e.target.value)} placeholder="Gogoro VIVA、Model 3…" className={inputCls} /></Field>
                {moneyField('value', '價值')}
            </>;
            break;
        case 'liabilities':
            body = <>
                {nameField('學貸、房貸、信用卡…')}
                <Field label="類型"><Chips value={f.kind as FinanceLiabilityItem['kind']} options={LIABILITY_KIND_LABELS} onChange={set('kind')} /></Field>
                <div className="grid grid-cols-2 gap-3">{moneyField('owed', '尚欠')}{moneyField('monthlyPayment', '每月還款')}</div>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="剩幾期" hint="可不填"><input value={f.remainingTerms || ''} onChange={e => set('remainingTerms')(e.target.value)} placeholder="—" inputMode="numeric" className={inputCls} /></Field>
                    {f.kind === 'credit' ? moneyField('creditLimit', '信用額度') : <div />}
                </div>
                {num(f.monthlyPayment) > 0 && recurring('每月自動還款', '那天扣一期：帳戶扣錢、尚欠減少、期數減一', '從哪扣')}
            </>;
            break;
        case 'others':
            body = <>
                {nameField('鋼筆、手錶、收藏…')}
                {moneyField('value', '價值')}
            </>;
            break;
    }

    return (
        <Modal isOpen title={title} onClose={onClose}
            footer={confirmDelete ? (
                <div className="flex gap-3 w-full">
                    <button onClick={() => setConfirmDelete(false)} className="flex-1 py-3 bg-slate-100 text-slate-500 font-bold rounded-2xl active:scale-95 transition-transform">取消</button>
                    <button onClick={() => target.item && onDelete(target.block, target.item.id)} className="flex-1 py-3 bg-rose-500 text-white font-bold rounded-2xl active:scale-95 transition-transform">確定刪除</button>
                </div>
            ) : (
                <div className="flex gap-3 w-full">
                    {editing && <button onClick={() => setConfirmDelete(true)} className="py-3 px-4 bg-rose-50 text-rose-500 font-bold rounded-2xl active:scale-95 transition-transform">刪除</button>}
                    <button onClick={save} className="flex-1 py-3 bg-slate-800 text-white font-bold rounded-2xl active:scale-95 transition-transform">保存</button>
                </div>
            )}>
            <div className="space-y-4">
                {body}
                <Field label="備註"><textarea value={f.note || ''} onChange={e => set('note')(e.target.value)} rows={2} placeholder="可不填" className={`${inputCls} resize-none`} /></Field>
                {confirmDelete && <p className="text-[11px] text-rose-500">刪掉這一項不會動到任何帳戶的錢，已經記過的流水也會留著。</p>}
            </div>
        </Modal>
    );
};

export default FinanceItemEditor;
