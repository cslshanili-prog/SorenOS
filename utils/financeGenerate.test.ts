import { describe, expect, it } from 'vitest';
import type { RealBalanceState } from '../types';
import {
    applyGeneratedFlows, applyGeneratedOverview, buildFlowPrompt, buildOverviewPrompt, buildUserOwnerContext,
    hasAiFlows, hasOverviewContent, parseFlows, parseOverview,
} from './financeGenerate';
import { computeNetWorth, financeBook, upsertFinanceItem } from './finance';

const now = new Date(2026, 9, 2, 15, 0);

const sample = {
    cash: '3,200',
    cards: [{ name: '三菱 薪轉戶', lastFour: '4821', balance: 85000 }, { name: '郵局定存', lastFour: 'ab', balance: '800000' }],
    incomes: [
        { name: '助教月薪', kind: 'salary', amount: 32000, fixed: true, dayOfMonth: 25, account: 'card1' },
        { name: '稿費', kind: 'other', amount: 3000, fixed: false },
        { name: '', amount: 1 },
    ],
    expenses: [{ name: '生活費', amount: 12000, dayOfMonth: 1, account: 'card1' }],
    investments: [{ name: '全球指數', kind: 'fund', cost: 60000, value: 66000, monthly: 3000, dayOfMonth: 5, account: 'card1' }],
    properties: [{ name: '學校旁套房', mode: 'renting', value: 999, monthlyRent: 9000, deposit: 18000, dayOfMonth: 27, leaseEnd: '2027-06-30', account: 'cash' }],
    vehicles: [{ kind: 'spaceship', model: '腳踏車', value: 5000 }],
    liabilities: [{ name: '學貸', kind: 'student', owed: 180000, monthlyPayment: 3000, dayOfMonth: 27, remainingTerms: 60, account: 'card9' }],
    others: [{ name: '鋼筆', value: 2100, note: '手寫筆記用' }],
};

describe('AI 生成總覽', () => {
    it('提示詞寫明必填與 JSON 形狀，帶上主人名字', () => {
        const p = buildOverviewPrompt('川雪');
        expect(p).toContain('替 川雪');
        expect(p).toContain('cash（身上現金）');
        expect(p).toContain('"kind": "salary|business|yield|other"');
    });

    it('解析：數字寬容、帳戶對到卡、固定項從下個到期日開始、亂寫的類型退回其他', () => {
        const gen = parseOverview(sample, now)!;
        expect(gen.balance).toBe(3200);
        expect(gen.cards.map(c => [c.name, c.lastFour, c.balance])).toEqual([['三菱 薪轉戶', '4821', 85000], ['郵局定存', expect.stringMatching(/^\d{4}$/), 800000]]);
        const [salary, freelance] = gen.finance.incomes;
        expect(gen.finance.incomes).toHaveLength(2);
        expect(salary.recurring).toEqual({ dayOfMonth: 25, accountId: gen.cards[0].id, lastPostedMonth: '2026-09' });
        expect(freelance.recurring).toBeUndefined();
        expect(gen.finance.expenses[0].recurring?.lastPostedMonth).toBe('2026-10');
        expect(gen.finance.investments[0].contribution).toMatchObject({ amount: 3000, dayOfMonth: 5, accountId: gen.cards[0].id });
        expect(gen.finance.properties[0]).toMatchObject({ mode: 'renting', value: undefined, lease: { monthlyRent: 9000, deposit: 18000, leaseEnd: '2027-06-30' } });
        expect(gen.finance.vehicles[0].kind).toBe('other');
        expect(gen.finance.liabilities[0].recurring?.accountId).toBe('cash'); // card9 不存在 → 現金
        expect(gen.finance.others[0]).toMatchObject({ name: '鋼筆', note: '手寫筆記用' });
    });

    it('什麼都沒有就回 null；不是物件也回 null', () => {
        expect(parseOverview({ cash: 0, cards: [], incomes: [] }, now)).toBeNull();
        expect(parseOverview('nope', now)).toBeNull();
        expect(parseOverview(null, now)).toBeNull();
    });

    it('套用：整份換掉現金、卡、各 block，流水保留', () => {
        const old: RealBalanceState = upsertFinanceItem({ balance: 50, cards: [], transactions: [{ id: 't', label: '舊', amount: 50, timestamp: 1, balanceAfter: 50 }] }, 'others', { id: 'x', name: '舊東西', value: 1 });
        expect(hasOverviewContent(old)).toBe(true);
        expect(hasOverviewContent({ balance: 0, cards: [], transactions: [] })).toBe(false);
        const next = applyGeneratedOverview(old, parseOverview(sample, now)!);
        expect(next.balance).toBe(3200);
        expect(next.transactions).toHaveLength(1);
        expect(financeBook(next).others.map(o => o.name)).toEqual(['鋼筆']);
        expect(computeNetWorth(next).netWorth).toBe(3200 + 885000 + 66000 + 5000 + 2100 - 180000);
    });
});

describe('AI 生成流水', () => {
    const state: RealBalanceState = { balance: 500, cards: [{ id: 'c1', name: '薪轉', lastFour: '0001', balance: 9000, color: 'gold', createdAt: 0 }], transactions: [] };

    it('提示詞列出帳戶與「不要再寫」的固定收支', () => {
        const withIncome = upsertFinanceItem(state, 'incomes', { id: 'i', name: '月薪', kind: 'salary', amount: 30000 });
        const p = buildFlowPrompt(withIncome, '川雪');
        expect(p).toContain('"card1"（薪轉 $9000）');
        expect(p).toContain('收入：月薪 $30000');
        expect(p).toContain('流水裡不要再寫');
    });

    it('解析：帳戶、時間、分類容錯；今天還沒到的時間拉回現在之前；不動餘額', () => {
        const flows = parseFlows({ flows: [
            { daysAgo: 0, time: '23:30', label: '宵夜', amount: -120, account: 'card1', category: 'food' },
            { daysAgo: 3, time: '08:05', label: '捷運', amount: '-25', account: 'cash', category: 'weird' },
            { daysAgo: 99, label: '紅包', amount: 600, account: 'card7', note: '阿嬤給的' },
            { label: '', amount: -1 },
            { label: '零元', amount: 0 },
        ] }, state, now);
        expect(flows.map(f => f.label)).toEqual(['宵夜', '捷運', '紅包']);
        expect(flows[0]).toMatchObject({ accountId: 'c1', category: 'food', source: 'ai' });
        expect(flows[0].timestamp).toBeLessThan(now.getTime());
        expect(new Date(flows[1].timestamp).getDate()).toBe(29);
        expect(flows[1].category).toBe('other');
        expect(flows[2]).toMatchObject({ accountId: 'cash', category: 'income', detail: '阿嬤給的' });
        expect(new Date(flows[2].timestamp).getMonth()).toBe(8); // 最多 29 天前
    });

    it('套用：換掉上次 AI 生成的那批，其他的不碰，餘額不變', () => {
        const before: RealBalanceState = { ...state, transactions: [
            { id: 'm', label: '手動', amount: -10, timestamp: 1, balanceAfter: 490, source: 'manual' },
            { id: 'a', label: '舊 AI', amount: -5, timestamp: 2, balanceAfter: 500, source: 'ai' },
        ] };
        expect(hasAiFlows(before)).toBe(true);
        const flows = parseFlows({ flows: [{ daysAgo: 1, label: '咖啡', amount: -60 }] }, before, now);
        const next = applyGeneratedFlows(before, flows);
        expect(next.transactions.map(t => t.label)).toEqual(['手動', '咖啡']);
        expect(next.balance).toBe(500);
    });
});

describe('用戶那邊的設定', () => {
    it('拿身份卡湊一段，空的欄位不寫', () => {
        const ctx = buildUserOwnerContext({ name: 'Liora', bio: '台北上班族', customSetting: '' } as any);
        expect(ctx).toContain('- 名字: Liora');
        expect(ctx).toContain('- 設定/備註: 台北上班族');
        expect(ctx).not.toContain('自定義設定');
    });
});
