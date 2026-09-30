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
