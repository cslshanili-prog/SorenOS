import { describe, it, expect } from 'vitest';
import {
    REAL_BALANCE_SEED,
    ensureRealBalanceState,
    createBankCard,
    deleteBankCard,
    transferCardToBalance,
    transferBalanceToCard,
    applyRealBalanceDelta,
} from './realBalance';
import type { RealBalanceState } from '../types';

describe('ensureRealBalanceState', () => {
    it('未初始化时生成种子状态：余额 = 种子值，带一条"初始余额"流水', () => {
        const state = ensureRealBalanceState(undefined);
        expect(state.balance).toBe(REAL_BALANCE_SEED);
        expect(state.cards).toEqual([]);
        expect(state.transactions).toHaveLength(1);
        expect(state.transactions[0].label).toBe('初始余额');
        expect(state.transactions[0].amount).toBe(REAL_BALANCE_SEED);
        expect(state.transactions[0].balanceAfter).toBe(REAL_BALANCE_SEED);
    });

    it('已经有状态时原样返回，不重新生成', () => {
        const existing: RealBalanceState = { balance: 42, cards: [], transactions: [] };
        expect(ensureRealBalanceState(existing)).toBe(existing);
    });
});

describe('createBankCard / deleteBankCard', () => {
    const base = ensureRealBalanceState(undefined);

    it('开卡不影响 Real Balance 余额，也不落流水', () => {
        const next = createBankCard(base, { name: '储蓄卡', lastFour: '1234', initialBalance: 1000, color: 'graphite' });
        expect(next.balance).toBe(base.balance);
        expect(next.transactions).toHaveLength(base.transactions.length);
        expect(next.cards).toHaveLength(1);
        expect(next.cards[0]).toMatchObject({ name: '储蓄卡', lastFour: '1234', balance: 1000, color: 'graphite' });
    });

    it('名称留空回退默认"储蓄卡"，尾号不足 4 位左补 0', () => {
        const next = createBankCard(base, { name: '  ', lastFour: '7', initialBalance: 0, color: 'gold' });
        expect(next.cards[0].name).toBe('储蓄卡');
        expect(next.cards[0].lastFour).toBe('0007');
    });

    it('初始余额不能为负，钳到 0', () => {
        const next = createBankCard(base, { name: 'x', lastFour: '1', initialBalance: -50, color: 'silver' });
        expect(next.cards[0].balance).toBe(0);
    });

    it('删卡：卡里有余额时拒绝', () => {
        const withCard = createBankCard(base, { name: 'x', lastFour: '1', initialBalance: 100, color: 'gold' });
        const result = deleteBankCard(withCard, withCard.cards[0].id);
        expect(result.ok).toBe(false);
        expect(withCard.cards).toHaveLength(1);
    });

    it('删卡：余额为 0 时成功移除', () => {
        const withCard = createBankCard(base, { name: 'x', lastFour: '1', initialBalance: 0, color: 'gold' });
        const result = deleteBankCard(withCard, withCard.cards[0].id);
        expect(result.ok).toBe(true);
        expect(result.state.cards).toHaveLength(0);
    });

    it('删除不存在的卡返回失败', () => {
        const result = deleteBankCard(base, 'nope');
        expect(result.ok).toBe(false);
    });
});

describe('transferCardToBalance / transferBalanceToCard', () => {
    const withCard = createBankCard(ensureRealBalanceState(undefined), { name: '储蓄卡', lastFour: '1234', initialBalance: 500, color: 'graphite' });
    const cardId = withCard.cards[0].id;

    it('转入账户：卡减、Real Balance 加，落一条"转入账户"流水', () => {
        const result = transferCardToBalance(withCard, cardId, 200);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.cards[0].balance).toBe(300);
        expect(result.state.balance).toBe(withCard.balance + 200);
        const lastTx = result.state.transactions[result.state.transactions.length - 1];
        expect(lastTx.label).toBe('转入账户');
        expect(lastTx.amount).toBe(200);
        expect(lastTx.cardId).toBe(cardId);
        expect(lastTx.balanceAfter).toBe(result.state.balance);
    });

    it('转入账户：卡余额不足时拒绝，状态不变', () => {
        const result = transferCardToBalance(withCard, cardId, 9999);
        expect(result.ok).toBe(false);
        expect(result.state).toBe(withCard);
    });

    it('转出账户：Real Balance 减、卡加，落一条"转出账户"流水（负数）', () => {
        const result = transferBalanceToCard(withCard, cardId, 300);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.cards[0].balance).toBe(800);
        expect(result.state.balance).toBe(withCard.balance - 300);
        const lastTx = result.state.transactions[result.state.transactions.length - 1];
        expect(lastTx.label).toBe('转出账户');
        expect(lastTx.amount).toBe(-300);
    });

    it('转出账户：Real Balance 不足时拒绝', () => {
        const result = transferBalanceToCard(withCard, cardId, withCard.balance + 1);
        expect(result.ok).toBe(false);
    });

    it('金额为 0 或负数一律拒绝', () => {
        expect(transferCardToBalance(withCard, cardId, 0).ok).toBe(false);
        expect(transferCardToBalance(withCard, cardId, -1).ok).toBe(false);
        expect(transferBalanceToCard(withCard, cardId, 0).ok).toBe(false);
    });
});

describe('applyRealBalanceDelta', () => {
    const base = ensureRealBalanceState(undefined);

    it('正数入账，落带正确 label/detail 的流水', () => {
        const result = applyRealBalanceDelta(base, 500, '收到 小夏 的转账', '来自私聊');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.balance).toBe(base.balance + 500);
        const lastTx = result.state.transactions[result.state.transactions.length - 1];
        expect(lastTx.label).toBe('收到 小夏 的转账');
        expect(lastTx.amount).toBe(500);
        expect(lastTx.detail).toBe('来自私聊');
    });

    it('负数出账，余额够时成功', () => {
        const result = applyRealBalanceDelta(base, -100, '转账给 小夏');
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.state.balance).toBe(base.balance - 100);
    });

    it('出账超过余额时拒绝，状态不变', () => {
        const result = applyRealBalanceDelta(base, -(base.balance + 1), '转账给 小夏');
        expect(result.ok).toBe(false);
        expect(result.state).toBe(base);
    });

    it('delta 为 0 时拒绝', () => {
        expect(applyRealBalanceDelta(base, 0, 'x').ok).toBe(false);
    });
});
