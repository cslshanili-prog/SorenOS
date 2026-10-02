import { describe, expect, it } from 'vitest';
import type { RealBalanceState } from '../types';
import {
    CASH_ACCOUNT,
    addManualFlow,
    canDeleteFlow,
    computeNetWorth,
    deleteFlow,
    filterFlows,
    financeBook,
    flowMonths,
    flowTotals,
    monthlySummary,
    recurringStartMonth,
    removeFinanceItem,
    rentalIncomes,
    upsertFinanceItem,
    withRecurringStart,
} from './finance';
import { createBankCard, transferBalanceToCard } from './realBalance';

const wallet = (balance = 1000): RealBalanceState => ({ balance, cards: [], transactions: [] });

function filled(): RealBalanceState {
    let s = createBankCard(wallet(1000), { name: '儲蓄卡', lastFour: '1234', initialBalance: 5000, color: 'graphite' });
    s = upsertFinanceItem(s, 'incomes', { id: 'i1', name: '助教月薪', kind: 'salary', amount: 30000, recurring: { dayOfMonth: 25, accountId: s.cards[0].id } });
    s = upsertFinanceItem(s, 'investments', { id: 'v1', name: '全球指數', kind: 'fund', cost: 20000, value: 23000, contribution: { amount: 2000, dayOfMonth: 5, accountId: CASH_ACCOUNT } });
    s = upsertFinanceItem(s, 'properties', { id: 'p1', name: '老家公寓', mode: 'own-rent', value: 3000000, lease: { monthlyRent: 15000, deposit: 30000 } });
    s = upsertFinanceItem(s, 'properties', { id: 'p2', name: '學校旁套房', mode: 'renting', lease: { monthlyRent: 9000, deposit: 18000 } });
    s = upsertFinanceItem(s, 'vehicles', { id: 'c1', kind: 'motorcycle', model: 'Gogoro', value: 40000 });
    s = upsertFinanceItem(s, 'liabilities', { id: 'l1', name: '學貸', kind: 'student', owed: 180000, monthlyPayment: 3000 });
    s = upsertFinanceItem(s, 'others', { id: 'o1', name: '鋼筆', value: 2100 });
    return s;
}

describe('總覽的 block', () => {
    it('舊錢包沒有 finance：各 block 補空', () => {
        expect(financeBook(wallet())).toEqual({ incomes: [], investments: [], properties: [], vehicles: [], liabilities: [], others: [] });
    });

    it('同 id 覆蓋、不同 id 追加、刪除只動那一塊', () => {
        let s = upsertFinanceItem(wallet(), 'others', { id: 'a', name: '手錶', value: 100 });
        s = upsertFinanceItem(s, 'others', { id: 'a', name: '手錶', value: 300 });
        s = upsertFinanceItem(s, 'others', { id: 'b', name: '耳機', value: 50 });
        expect(financeBook(s).others.map(o => o.value)).toEqual([300, 50]);
        s = removeFinanceItem(s, 'others', 'a');
        expect(financeBook(s).others.map(o => o.id)).toEqual(['b']);
        expect(s.balance).toBe(1000);
    });

    it('Net Worth = 資產 − 負債；租屋不算資產', () => {
        const nw = computeNetWorth(filled());
        expect(nw).toMatchObject({ cash: 1000, cards: 5000, investments: 23000, properties: 3000000, vehicles: 40000, others: 2100, liabilities: 180000 });
        expect(nw.assets).toBe(3071100);
        expect(nw.netWorth).toBe(2891100);
        expect(computeNetWorth(wallet(0)).netWorth).toBe(0);
    });

    it('月收入含收租；月固定支出 = 交租＋定投＋還款', () => {
        const s = filled();
        expect(rentalIncomes(s)).toEqual([{ propertyId: 'p1', name: '出租：老家公寓', amount: 15000, dayOfMonth: undefined }]);
        expect(monthlySummary(s)).toEqual({ income: 45000, fixedOut: 14000 });
    });
});

describe('固定收支的起點', () => {
    it('今天還沒到那天：下一次是這個月；已經過了（含當天）：下一次是下個月', () => {
        expect(recurringStartMonth(25, new Date(2026, 9, 2))).toBe('2026-09');
        expect(recurringStartMonth(2, new Date(2026, 9, 2))).toBe('2026-10');
        expect(recurringStartMonth(1, new Date(2026, 0, 15))).toBe('2026-01');
        expect(recurringStartMonth(20, new Date(2026, 0, 15))).toBe('2025-12');
    });

    it('編輯時保留原本進度，新開的才算起點；日子夾在 1–31', () => {
        const now = new Date(2026, 9, 2);
        expect(withRecurringStart({ dayOfMonth: 40, accountId: 'cash' }, undefined, now)).toEqual({ dayOfMonth: 31, accountId: 'cash', lastPostedMonth: '2026-09' });
        expect(withRecurringStart({ dayOfMonth: 5, accountId: 'cash' }, { dayOfMonth: 1, accountId: 'cash', lastPostedMonth: '2026-07' }, now)?.lastPostedMonth).toBe('2026-07');
        expect(withRecurringStart(undefined, { dayOfMonth: 1, accountId: 'cash' }, now)).toBeUndefined();
    });
});

describe('流水：手動新增與刪除', () => {
    it('收入進現金、支出從卡扣，balanceAfter 是那個帳戶的餘額', () => {
        let s = createBankCard(wallet(100), { name: '卡', lastFour: '0001', initialBalance: 500, color: 'gold' });
        const cardId = s.cards[0].id;
        let r = addManualFlow(s, { direction: 'in', amount: 50, accountId: CASH_ACCOUNT, category: 'income', label: '' });
        expect(r.ok).toBe(true);
        s = r.state;
        expect(s.balance).toBe(150);
        expect(s.transactions.at(-1)).toMatchObject({ label: '其他收入', amount: 50, balanceAfter: 150, accountId: 'cash', source: 'manual' });
        r = addManualFlow(s, { direction: 'out', amount: 120, accountId: cardId, category: 'food', label: '燒肉', note: '跟同學' });
        s = r.state;
        expect(s.cards[0].balance).toBe(380);
        expect(s.balance).toBe(150);
        expect(s.transactions.at(-1)).toMatchObject({ label: '燒肉', detail: '跟同學', amount: -120, balanceAfter: 380, accountId: cardId });
    });

    it('不夠扣、金額不對、卡不存在都擋下，狀態不變', () => {
        const s = wallet(10);
        expect(addManualFlow(s, { direction: 'out', amount: 11, accountId: 'cash', category: 'food', label: 'x' })).toMatchObject({ ok: false, reason: '現金不夠', state: s });
        expect(addManualFlow(s, { direction: 'in', amount: 0, accountId: 'cash', category: 'income', label: 'x' }).ok).toBe(false);
        expect(addManualFlow(s, { direction: 'in', amount: 1, accountId: 'nope', category: 'income', label: 'x' }).ok).toBe(false);
    });

    it('刪手動的退回金額；刪 AI 生成的不動餘額；聊天記的不能刪', () => {
        let s = addManualFlow(wallet(100), { direction: 'out', amount: 30, accountId: 'cash', category: 'food', label: '午餐' }).state;
        const manual = s.transactions[0];
        s = { ...s, transactions: [...s.transactions,
            { id: 'ai1', label: '咖啡', amount: -5, timestamp: 1, balanceAfter: 70, source: 'ai' },
            { id: 'chat1', label: '轉帳給小夏', amount: -10, timestamp: 2, balanceAfter: 60 }] };
        expect(canDeleteFlow(s.transactions[2])).toBe(false);
        expect(deleteFlow(s, 'chat1').ok).toBe(false);
        let r = deleteFlow(s, 'ai1');
        expect(r.state.balance).toBe(70);
        r = deleteFlow(r.state, manual.id);
        expect(r.state.balance).toBe(100);
        expect(r.state.transactions.map(t => t.id)).toEqual(['chat1']);
    });

    it('退回會讓帳戶變負就不給刪', () => {
        let s = addManualFlow(wallet(0), { direction: 'in', amount: 50, accountId: 'cash', category: 'income', label: '稿費' }).state;
        s = { ...s, balance: 10 };
        expect(deleteFlow(s, s.transactions[0].id)).toMatchObject({ ok: false });
    });
});

describe('流水頁的篩選與合計', () => {
    it('按月份、帳戶篩；互轉不算收支', () => {
        let s = createBankCard(wallet(1000), { name: '卡', lastFour: '0001', initialBalance: 0, color: 'gold' });
        const cardId = s.cards[0].id;
        s = transferBalanceToCard(s, cardId, 200).state;
        s = addManualFlow(s, { direction: 'out', amount: 30, accountId: cardId, category: 'food', label: '午餐', timestamp: new Date(2026, 9, 1, 12).getTime() }).state;
        s = addManualFlow(s, { direction: 'in', amount: 500, accountId: 'cash', category: 'salary', label: '打工', timestamp: new Date(2026, 8, 30, 12).getTime() }).state;
        const october = filterFlows(s, { month: '2026-10' });
        expect(october.map(t => t.label)).toContain('午餐');
        expect(october.map(t => t.label)).not.toContain('打工');
        expect(filterFlows(s, { accountId: cardId }).map(t => t.label)).toEqual(expect.arrayContaining(['午餐', '轉出帳戶']));
        expect(filterFlows(s, { accountId: 'cash' }).map(t => t.label)).not.toContain('午餐');
        expect(flowTotals(filterFlows(s, {}))).toEqual({ income: 500, expense: 30 });
        expect(flowMonths(s, new Date(2026, 9, 2))[0] >= '2026-10').toBe(true);
    });
});
