import { describe, expect, it } from 'vitest';
import type { RealBalanceState } from '../types';
import { createBankCard } from './realBalance';
import { financeBook, upsertFinanceItem } from './finance';
import { MAX_CATCH_UP_MONTHS, dueDate, dueMonths, hasDueRecurring, settleRecurring } from './financeRecurring';

const wallet = (balance = 0): RealBalanceState => ({ balance, cards: [], transactions: [] });
const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h);

describe('到期月份', () => {
    it('當月沒有那天就算月底', () => {
        expect(dueDate(2026, 1, 31).getDate()).toBe(28); // 2026-02
        expect(dueDate(2028, 1, 31).getDate()).toBe(29); // 閏年
        expect(dueDate(2026, 3, 31).getDate()).toBe(30); // 4 月
    });

    it('從 lastPostedMonth 的下個月算起，日子沒到的不算；跨年也對', () => {
        const rec = { dayOfMonth: 25, accountId: 'cash', lastPostedMonth: '2025-11' };
        expect(dueMonths(rec, at(2026, 1, 24)).map(d => d.month)).toEqual(['2025-12']);
        expect(dueMonths(rec, at(2026, 1, 25)).map(d => d.month)).toEqual(['2025-12', '2026-01']);
        expect(dueMonths({ ...rec, lastPostedMonth: undefined }, at(2026, 1, 25))).toEqual([]);
    });

    it('很久沒開：最多補 12 個月（最近的那 12 個）', () => {
        const months = dueMonths({ dayOfMonth: 1, accountId: 'cash', lastPostedMonth: '2023-01' }, at(2026, 10, 2));
        expect(months).toHaveLength(MAX_CATCH_UP_MONTHS);
        expect(months[0].month).toBe('2025-11');
        expect(months.at(-1)!.month).toBe('2026-10');
    });
});

describe('自動補記', () => {
    it('薪資進卡、房租從現金扣、按時間順序算 balanceAfter；再跑一次不重記', () => {
        let s = createBankCard(wallet(10000), { name: '薪轉', lastFour: '0001', initialBalance: 0, color: 'gold' });
        const cardId = s.cards[0].id;
        s = upsertFinanceItem(s, 'incomes', { id: 'i', name: '助教月薪', kind: 'salary', amount: 30000, recurring: { dayOfMonth: 25, accountId: cardId, lastPostedMonth: '2026-08' } });
        s = upsertFinanceItem(s, 'properties', { id: 'p', name: '學校旁套房', mode: 'renting', lease: { monthlyRent: 9000, recurring: { dayOfMonth: 5, accountId: 'cash', lastPostedMonth: '2026-08' } } });
        const now = at(2026, 10, 2);
        expect(hasDueRecurring(s, now)).toBe(true);
        const r = settleRecurring(s, now);
        expect(r.changed).toBe(true);
        expect(r.posted).toBe(2);
        expect(r.state.cards[0].balance).toBe(30000);
        expect(r.state.balance).toBe(1000);
        const auto = r.state.transactions.filter(t => t.source === 'auto');
        expect(auto.map(t => [t.label, t.amount, t.balanceAfter])).toEqual([
            ['房租：學校旁套房', -9000, 1000],
            ['助教月薪', 30000, 30000],
        ]);
        expect(auto[1]).toMatchObject({ accountId: cardId, category: 'salary' });
        expect(financeBook(r.state).incomes[0].recurring?.lastPostedMonth).toBe('2026-09');
        expect(financeBook(r.state).properties[0].lease?.recurring?.lastPostedMonth).toBe('2026-09');
        const again = settleRecurring(r.state, now);
        expect(again.changed).toBe(false);
        expect(hasDueRecurring(r.state, now)).toBe(false);
    });

    it('先進後扣：同月份薪資比房租早到就付得出來', () => {
        let s = wallet(0);
        s = upsertFinanceItem(s, 'incomes', { id: 'i', name: '打工', kind: 'salary', amount: 5000, recurring: { dayOfMonth: 1, accountId: 'cash', lastPostedMonth: '2026-09' } });
        s = upsertFinanceItem(s, 'properties', { id: 'p', name: '雅房', mode: 'renting', lease: { monthlyRent: 4000, recurring: { dayOfMonth: 2, accountId: 'cash', lastPostedMonth: '2026-09' } } });
        const r = settleRecurring(s, at(2026, 10, 2));
        expect(r.state.balance).toBe(1000);
    });

    it('不夠扣：記一筆 0 元的扣款失敗，餘額不變負，進度照樣往前', () => {
        let s = wallet(100);
        s = upsertFinanceItem(s, 'liabilities', { id: 'l', name: '學貸', kind: 'student', owed: 5000, monthlyPayment: 3000, remainingTerms: 2, recurring: { dayOfMonth: 27, accountId: 'cash', lastPostedMonth: '2026-08' } });
        const r = settleRecurring(s, at(2026, 10, 2));
        expect(r.state.balance).toBe(100);
        expect(r.state.transactions.at(-1)).toMatchObject({ label: '扣款失敗：學貸', amount: 0, source: 'auto' });
        expect(financeBook(r.state).liabilities[0]).toMatchObject({ owed: 5000, remainingTerms: 2 });
        expect(financeBook(r.state).liabilities[0].recurring?.lastPostedMonth).toBe('2026-09');
    });

    it('還款：尚欠與期數往下減，最後一期只扣剩下的，還清就不再扣', () => {
        let s = wallet(100000);
        s = upsertFinanceItem(s, 'liabilities', { id: 'l', name: '車貸', kind: 'loan', owed: 5000, monthlyPayment: 3000, remainingTerms: 5, recurring: { dayOfMonth: 1, accountId: 'cash', lastPostedMonth: '2026-06' } });
        const r = settleRecurring(s, at(2026, 10, 2));
        expect(r.state.transactions.map(t => t.amount)).toEqual([-3000, -2000]);
        expect(financeBook(r.state).liabilities[0]).toMatchObject({ owed: 0, remainingTerms: 3 });
        expect(r.state.balance).toBe(95000);
        expect(financeBook(r.state).liabilities[0].recurring?.lastPostedMonth).toBe('2026-10');
    });

    it('固定支出：到了那天從帳戶扣', () => {
        let s = wallet(10000);
        s = upsertFinanceItem(s, 'expenses', { id: 'e', name: '生活費', amount: 6000, recurring: { dayOfMonth: 1, accountId: 'cash', lastPostedMonth: '2026-09' } });
        const r = settleRecurring(s, at(2026, 10, 2));
        expect(r.state.balance).toBe(4000);
        expect(r.state.transactions[0]).toMatchObject({ label: '生活費', amount: -6000, category: 'bills', source: 'auto' });
        expect(financeBook(r.state).expenses[0].recurring?.lastPostedMonth).toBe('2026-10');
    });

    it('定投：從帳戶扣，成本和現值一起加', () => {
        let s = wallet(10000);
        s = upsertFinanceItem(s, 'investments', { id: 'v', name: '全球指數', kind: 'fund', cost: 1000, value: 1200, contribution: { amount: 500, dayOfMonth: 5, accountId: 'cash', lastPostedMonth: '2026-08' } });
        const r = settleRecurring(s, at(2026, 10, 6));
        expect(r.state.balance).toBe(9000);
        expect(financeBook(r.state).investments[0]).toMatchObject({ cost: 2000, value: 2200 });
        expect(r.state.transactions.every(t => t.label === '定投：全球指數' && t.category === 'investment')).toBe(true);
    });

    it('收租進帳；租約到期後的月份不收，但進度照樣往前', () => {
        let s = wallet(0);
        s = upsertFinanceItem(s, 'properties', { id: 'p', name: '老家公寓', mode: 'own-rent', value: 3000000, lease: { monthlyRent: 15000, leaseEnd: '2026-08-31', recurring: { dayOfMonth: 10, accountId: 'cash', lastPostedMonth: '2026-06' } } });
        const r = settleRecurring(s, at(2026, 10, 12));
        expect(r.state.transactions.map(t => t.label)).toEqual(['收租：老家公寓', '收租：老家公寓']);
        expect(r.state.balance).toBe(30000);
        expect(financeBook(r.state).properties[0].lease?.recurring?.lastPostedMonth).toBe('2026-10');
    });

    it('卡已經刪了：記扣款失敗，不動其他帳戶', () => {
        let s = wallet(500);
        s = upsertFinanceItem(s, 'incomes', { id: 'i', name: '月薪', kind: 'salary', amount: 100, recurring: { dayOfMonth: 1, accountId: 'card-gone', lastPostedMonth: '2026-09' } });
        const r = settleRecurring(s, at(2026, 10, 2));
        expect(r.state.balance).toBe(500);
        expect(r.state.transactions[0]).toMatchObject({ amount: 0, detail: '那張卡已經刪了' });
    });

    it('沒有 finance 或沒有固定項目：原樣返回', () => {
        const s = wallet(1);
        expect(settleRecurring(s)).toEqual({ state: s, posted: 0, changed: false });
        const withBook = upsertFinanceItem(s, 'others', { id: 'o', name: '筆', value: 1 });
        expect(settleRecurring(withBook).changed).toBe(false);
    });
});
