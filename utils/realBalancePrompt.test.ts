import { describe, it, expect } from 'vitest';
import { buildRealBalanceBlock } from './realBalancePrompt';

const tx = (label: string, amount: number, i: number) => ({ id: `t${i}`, label, amount, timestamp: i, balanceAfter: 0 });

describe('buildRealBalanceBlock', () => {
    it('從沒建過錢包：不給', () => {
        expect(buildRealBalanceBlock(undefined)).toBe('');
    });

    it('餘額、銀行卡、最近三筆（新的在前），出帳用減號', () => {
        const text = buildRealBalanceBlock({
            balance: 62,
            cards: [{ id: 'k', name: 'NS BANK', lastFour: '0099', balance: 1000000, color: 'gold', createdAt: 0 }],
            transactions: [
                tx('初始餘額', 10000, 1),
                tx('轉出帳戶', -9900, 2),
                tx('收到小柔的轉帳', 20, 3),
                tx('送給小柔的禮物', -58, 4),
            ],
        });
        expect(text).toContain('【你的錢包】');
        expect(text).toContain('錢包（Real Balance）餘額：$62.00');
        expect(text).toContain('銀行卡：NS BANK 尾號 0099 $1000000.00');
        expect(text).toContain('最近的流水：送給小柔的禮物 −$58.00、收到小柔的轉帳 +$20.00、轉出帳戶 −$9900.00');
        expect(text).not.toContain('初始餘額');
    });

    it('沒有卡就不寫銀行卡那行', () => {
        const text = buildRealBalanceBlock({ balance: 10000, cards: [], transactions: [tx('初始餘額', 10000, 1)] });
        expect(text).not.toContain('銀行卡');
        expect(text).toContain('初始餘額 +$10000.00');
    });
});

describe('buildRealBalanceBlock · 總覽那幾塊', () => {
    it('有填總覽才多 Net Worth、名下、每月固定；沒填的舊錢包一行都不加', () => {
        const base = { balance: 1000, cards: [], transactions: [] };
        expect(buildRealBalanceBlock(base)).not.toContain('Net Worth');
        const text = buildRealBalanceBlock({
            ...base,
            finance: {
                incomes: [{ id: 'i', name: '助教月薪', kind: 'salary', amount: 32000, recurring: { dayOfMonth: 25, accountId: 'cash' } }],
                expenses: [],
                investments: [],
                properties: [
                    { id: 'p', name: '學校旁套房', mode: 'renting', lease: { monthlyRent: 9000, recurring: { dayOfMonth: 27, accountId: 'cash' } } },
                    { id: 'q', name: '老家公寓', mode: 'own-rent', value: 3000000, lease: { monthlyRent: 15000 } },
                ],
                vehicles: [{ id: 'v', kind: 'motorcycle', model: 'Gogoro', value: 40000 }],
                liabilities: [{ id: 'l', name: '學貸', kind: 'student', owed: 180000, monthlyPayment: 3000, remainingTerms: 60, recurring: { dayOfMonth: 27, accountId: 'cash' } }],
                others: [],
            },
        });
        expect(text).toContain('Net Worth：$2,861,000（資產 $3,041,000，負債 $180,000）；月收入約 $47,000，每月固定支出 $12,000');
        expect(text).toContain('名下：老家公寓（出租中）、Gogoro');
        expect(text).toContain('每月固定：25 號發薪（助教月薪 $32,000，進現金）；27 號交房租（學校旁套房 $9,000）；學貸還欠 $180,000，每月 27 號還 $3,000，還剩 60 期');
    });
});
