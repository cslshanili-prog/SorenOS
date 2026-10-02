import { describe, it, expect } from 'vitest';
import {
    REAL_BALANCE_SEED,
    ensureRealBalanceState,
    createBankCard,
    transferCardToBalance,
    transferBalanceToCard,
    applyRealBalanceDelta,
} from './realBalance';
import type { RealBalanceState } from '../types';

describe('ensureRealBalanceState', () => {
    it('未初始化時生成空錢包：餘額 0，沒有流水', () => {
        const state = ensureRealBalanceState(undefined);
        expect(REAL_BALANCE_SEED).toBe(0);
        expect(state).toEqual({ balance: 0, cards: [], transactions: [] });
    });

    it('已經有狀態時原樣返回，不重新生成', () => {
        const existing: RealBalanceState = { balance: 42, cards: [], transactions: [] };
        expect(ensureRealBalanceState(existing)).toBe(existing);
    });
});

describe('createBankCard', () => {
    const base: RealBalanceState = { balance: 10000, cards: [], transactions: [] };

    it('開卡不影響 Real Balance 餘額，也不落流水', () => {
        const next = createBankCard(base, { name: '儲蓄卡', lastFour: '1234', initialBalance: 1000, color: 'graphite' });
        expect(next.balance).toBe(base.balance);
        expect(next.transactions).toHaveLength(base.transactions.length);
        expect(next.cards).toHaveLength(1);
        expect(next.cards[0]).toMatchObject({ name: '儲蓄卡', lastFour: '1234', balance: 1000, color: 'graphite' });
    });

    it('名稱留空回退默認"儲蓄卡"，尾號不足 4 位左補 0', () => {
        const next = createBankCard(base, { name: '  ', lastFour: '7', initialBalance: 0, color: 'gold' });
        expect(next.cards[0].name).toBe('儲蓄卡');
        expect(next.cards[0].lastFour).toBe('0007');
    });

    it('初始餘額不能為負，鉗到 0', () => {
        const next = createBankCard(base, { name: 'x', lastFour: '1', initialBalance: -50, color: 'silver' });
        expect(next.cards[0].balance).toBe(0);
    });

});

describe('transferCardToBalance / transferBalanceToCard', () => {
    const withCard = createBankCard({ balance: 10000, cards: [], transactions: [] }, { name: '儲蓄卡', lastFour: '1234', initialBalance: 500, color: 'graphite' });
    const cardId = withCard.cards[0].id;

    it('轉入帳戶：卡減、Real Balance 加，落一條"轉入帳戶"流水', () => {
        const result = transferCardToBalance(withCard, cardId, 200);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.cards[0].balance).toBe(300);
        expect(result.state.balance).toBe(withCard.balance + 200);
        const lastTx = result.state.transactions[result.state.transactions.length - 1];
        expect(lastTx.label).toBe('轉入帳戶');
        expect(lastTx.amount).toBe(200);
        expect(lastTx.cardId).toBe(cardId);
        expect(lastTx.balanceAfter).toBe(result.state.balance);
    });

    it('轉入帳戶：卡餘額不足時拒絕，狀態不變', () => {
        const result = transferCardToBalance(withCard, cardId, 9999);
        expect(result.ok).toBe(false);
        expect(result.state).toBe(withCard);
    });

    it('轉出帳戶：Real Balance 減、卡加，落一條"轉出帳戶"流水（負數）', () => {
        const result = transferBalanceToCard(withCard, cardId, 300);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.cards[0].balance).toBe(800);
        expect(result.state.balance).toBe(withCard.balance - 300);
        const lastTx = result.state.transactions[result.state.transactions.length - 1];
        expect(lastTx.label).toBe('轉出帳戶');
        expect(lastTx.amount).toBe(-300);
    });

    it('轉出帳戶：Real Balance 不足時拒絕', () => {
        const result = transferBalanceToCard(withCard, cardId, withCard.balance + 1);
        expect(result.ok).toBe(false);
    });

    it('金額為 0 或負數一律拒絕', () => {
        expect(transferCardToBalance(withCard, cardId, 0).ok).toBe(false);
        expect(transferCardToBalance(withCard, cardId, -1).ok).toBe(false);
        expect(transferBalanceToCard(withCard, cardId, 0).ok).toBe(false);
    });
});

describe('applyRealBalanceDelta', () => {
    const base: RealBalanceState = { balance: 10000, cards: [], transactions: [] };

    it('正數入帳，落帶正確 label/detail 的流水', () => {
        const result = applyRealBalanceDelta(base, 500, '收到 小夏 的轉帳', '來自私聊');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.balance).toBe(base.balance + 500);
        const lastTx = result.state.transactions[result.state.transactions.length - 1];
        expect(lastTx.label).toBe('收到 小夏 的轉帳');
        expect(lastTx.amount).toBe(500);
        expect(lastTx.detail).toBe('來自私聊');
    });

    it('負數出帳，餘額夠時成功', () => {
        const result = applyRealBalanceDelta(base, -100, '轉帳給 小夏');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.balance).toBe(base.balance - 100);
    });

    it('出帳超過餘額時拒絕，狀態不變', () => {
        const result = applyRealBalanceDelta(base, -(base.balance + 1), '轉帳給 小夏');
        expect(result.ok).toBe(false);
        expect(result.state).toBe(base);
    });

    it('delta 為 0 時拒絕', () => {
        expect(applyRealBalanceDelta(base, 0, 'x').ok).toBe(false);
    });
});
