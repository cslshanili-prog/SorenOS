// Real Balance 钱包 —— Chat 主页「主页」栏的模拟钱包：一个总余额 + 若干张可互转的银行卡 + 一条共用流水。
// 跟 utils/db.ts 的 BankTransaction（旧「存钱罐」经营游戏的账本）是两套完全独立的系统，字段名故意不撞。
import type { BankCard, RealBalanceState, RealBalanceTransaction } from '../types';
import { roundMoney } from './format';

/** 首次打开「主页」栏时的种子余额；ensureRealBalanceState 只在从没初始化过时用它建号。 */
export const REAL_BALANCE_SEED = 10000;

export type RealBalanceResult = { state: RealBalanceState; ok: true } | { state: RealBalanceState; ok: false; reason: string };

let txSeq = 0;
const makeTxId = (): string => `rbtx-${Date.now()}-${(txSeq++).toString(36)}`;

/** 已经初始化过就原样返回；没有就生成种子状态（不落库，调用方负责持久化）。 */
export function ensureRealBalanceState(state: RealBalanceState | undefined): RealBalanceState {
    if (state) return state;
    const now = Date.now();
    const seedTx: RealBalanceTransaction = {
        id: makeTxId(),
        label: '初始余额',
        amount: REAL_BALANCE_SEED,
        detail: '系统自动创建余额账户',
        timestamp: now,
        balanceAfter: REAL_BALANCE_SEED,
    };
    return { balance: REAL_BALANCE_SEED, cards: [], transactions: [seedTx] };
}

const pushTx = (
    state: RealBalanceState,
    nextBalance: number,
    tx: Omit<RealBalanceTransaction, 'id' | 'timestamp' | 'balanceAfter'>,
): RealBalanceState => ({
    ...state,
    balance: nextBalance,
    transactions: [
        ...state.transactions,
        { ...tx, id: makeTxId(), timestamp: Date.now(), balanceAfter: nextBalance },
    ],
});

/** 开一张新卡——初始余额是卡自己的钱，没经过 Real Balance，所以不落流水。 */
export function createBankCard(
    state: RealBalanceState,
    input: { name: string; lastFour: string; initialBalance: number; color: BankCard['color'] },
): RealBalanceState {
    const card: BankCard = {
        id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: input.name.trim() || '储蓄卡',
        lastFour: (input.lastFour || '').replace(/\D/g, '').padStart(4, '0').slice(-4),
        balance: Math.max(0, roundMoney(input.initialBalance)),
        color: input.color,
        createdAt: Date.now(),
    };
    return { ...state, cards: [...state.cards, card] };
}

/** 删卡：卡里还有钱不让删——钱不能就这么凭空消失，得先转出账户清零。 */
export function deleteBankCard(state: RealBalanceState, cardId: string): RealBalanceResult {
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { state, ok: false, reason: '这张卡不存在' };
    if (card.balance > 0) return { state, ok: false, reason: '这张卡还有余额，请先转出账户再删除' };
    return { state: { ...state, cards: state.cards.filter(c => c.id !== cardId) }, ok: true };
}

/** 银行卡 → Real Balance（卡的「转入账户」）。 */
export function transferCardToBalance(state: RealBalanceState, cardId: string, amount: number): RealBalanceResult {
    const amt = roundMoney(amount);
    if (!(amt > 0)) return { state, ok: false, reason: '金额必须大于 0' };
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { state, ok: false, reason: '这张卡不存在' };
    if (card.balance < amt) return { state, ok: false, reason: '这张卡余额不足' };
    const nextCards = state.cards.map(c => c.id === cardId ? { ...c, balance: roundMoney(c.balance - amt) } : c);
    const nextBalance = roundMoney(state.balance + amt);
    const next = pushTx({ ...state, cards: nextCards }, nextBalance, {
        label: '转入账户', amount: amt, detail: `${card.name} 转入账户 ¥${amt.toFixed(2)}`, cardId,
    });
    return { state: next, ok: true };
}

/** Real Balance → 银行卡（卡的「转出账户」/顶部「提现」）。 */
export function transferBalanceToCard(state: RealBalanceState, cardId: string, amount: number): RealBalanceResult {
    const amt = roundMoney(amount);
    if (!(amt > 0)) return { state, ok: false, reason: '金额必须大于 0' };
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { state, ok: false, reason: '这张卡不存在' };
    if (state.balance < amt) return { state, ok: false, reason: 'Real Balance 余额不足' };
    const nextCards = state.cards.map(c => c.id === cardId ? { ...c, balance: roundMoney(c.balance + amt) } : c);
    const nextBalance = roundMoney(state.balance - amt);
    const next = pushTx({ ...state, cards: nextCards }, nextBalance, {
        label: '转出账户', amount: -amt, detail: `${card.name} 转出账户 ¥${amt.toFixed(2)}`, cardId,
    });
    return { state: next, ok: true };
}

/**
 * 通用的 Real Balance 增减入口——聊天转账/红包这类不涉及银行卡的场景走这个。
 * delta 带符号：正 = 入账（收到转账），负 = 出账（发出转账，余额不够会被拒）。
 */
export function applyRealBalanceDelta(
    state: RealBalanceState,
    delta: number,
    label: string,
    detail?: string,
): RealBalanceResult {
    const amt = roundMoney(delta);
    if (amt === 0) return { state, ok: false, reason: '金额不能为 0' };
    const nextBalance = roundMoney(state.balance + amt);
    if (nextBalance < 0) return { state, ok: false, reason: 'Real Balance 余额不足' };
    return { state: pushTx(state, nextBalance, { label, amount: amt, detail }), ok: true };
}
