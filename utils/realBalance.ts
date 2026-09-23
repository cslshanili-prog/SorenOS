// Real Balance 錢包 —— Chat 主頁「主頁」欄的模擬錢包：一個總餘額 + 若干張可互轉的銀行卡 + 一條共用流水。
// 跟 utils/db.ts 的 BankTransaction（舊「存錢罐」經營遊戲的帳本）是兩套完全獨立的系統，字段名故意不撞。
import type { BankCard, RealBalanceState, RealBalanceTransaction } from '../types';
import { roundMoney } from './format';

/** 首次打開「主頁」欄時的種子餘額；ensureRealBalanceState 只在從沒初始化過時用它建號。 */
export const REAL_BALANCE_SEED = 10000;

export type RealBalanceResult = { state: RealBalanceState; ok: true } | { state: RealBalanceState; ok: false; reason: string };

let txSeq = 0;
const makeTxId = (): string => `rbtx-${Date.now()}-${(txSeq++).toString(36)}`;

/** 已經初始化過就原樣返回；沒有就生成種子狀態（不落庫，調用方負責持久化）。 */
export function ensureRealBalanceState(state: RealBalanceState | undefined): RealBalanceState {
    if (state) return state;
    const now = Date.now();
    const seedTx: RealBalanceTransaction = {
        id: makeTxId(),
        label: '初始餘額',
        amount: REAL_BALANCE_SEED,
        detail: '系統自動創建餘額帳戶',
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

/** 開一張新卡——初始餘額是卡自己的錢，沒經過 Real Balance，所以不落流水。 */
export function createBankCard(
    state: RealBalanceState,
    input: { name: string; lastFour: string; initialBalance: number; color: BankCard['color'] },
): RealBalanceState {
    const card: BankCard = {
        id: `card-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: input.name.trim() || '儲蓄卡',
        lastFour: (input.lastFour || '').replace(/\D/g, '').padStart(4, '0').slice(-4),
        balance: Math.max(0, roundMoney(input.initialBalance)),
        color: input.color,
        createdAt: Date.now(),
    };
    return { ...state, cards: [...state.cards, card] };
}

/** 刪卡：卡里還有錢不讓刪——錢不能就這麼憑空消失，得先轉出帳戶清零。 */
export function deleteBankCard(state: RealBalanceState, cardId: string): RealBalanceResult {
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { state, ok: false, reason: '這張卡不存在' };
    if (card.balance > 0) return { state, ok: false, reason: '這張卡還有餘額，請先轉出帳戶再刪除' };
    return { state: { ...state, cards: state.cards.filter(c => c.id !== cardId) }, ok: true };
}

/** 銀行卡 → Real Balance（卡的「轉入帳戶」）。 */
export function transferCardToBalance(state: RealBalanceState, cardId: string, amount: number): RealBalanceResult {
    const amt = roundMoney(amount);
    if (!(amt > 0)) return { state, ok: false, reason: '金額必須大於 0' };
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { state, ok: false, reason: '這張卡不存在' };
    if (card.balance < amt) return { state, ok: false, reason: '這張卡餘額不足' };
    const nextCards = state.cards.map(c => c.id === cardId ? { ...c, balance: roundMoney(c.balance - amt) } : c);
    const nextBalance = roundMoney(state.balance + amt);
    const next = pushTx({ ...state, cards: nextCards }, nextBalance, {
        label: '轉入帳戶', amount: amt, detail: `${card.name} 轉入帳戶 ¥${amt.toFixed(2)}`, cardId,
    });
    return { state: next, ok: true };
}

/** Real Balance → 銀行卡（卡的「轉出帳戶」/頂部「提現」）。 */
export function transferBalanceToCard(state: RealBalanceState, cardId: string, amount: number): RealBalanceResult {
    const amt = roundMoney(amount);
    if (!(amt > 0)) return { state, ok: false, reason: '金額必須大於 0' };
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { state, ok: false, reason: '這張卡不存在' };
    if (state.balance < amt) return { state, ok: false, reason: 'Real Balance 餘額不足' };
    const nextCards = state.cards.map(c => c.id === cardId ? { ...c, balance: roundMoney(c.balance + amt) } : c);
    const nextBalance = roundMoney(state.balance - amt);
    const next = pushTx({ ...state, cards: nextCards }, nextBalance, {
        label: '轉出帳戶', amount: -amt, detail: `${card.name} 轉出帳戶 ¥${amt.toFixed(2)}`, cardId,
    });
    return { state: next, ok: true };
}

/**
 * 通用的 Real Balance 增減入口——聊天轉帳/紅包這類不涉及銀行卡的場景走這個。
 * delta 帶符號：正 = 入帳（收到轉帳），負 = 出帳（發出轉帳，餘額不夠會被拒）。
 */
export function applyRealBalanceDelta(
    state: RealBalanceState,
    delta: number,
    label: string,
    detail?: string,
): RealBalanceResult {
    const amt = roundMoney(delta);
    if (amt === 0) return { state, ok: false, reason: '金額不能為 0' };
    const nextBalance = roundMoney(state.balance + amt);
    if (nextBalance < 0) return { state, ok: false, reason: 'Real Balance 餘額不足' };
    return { state: pushTx(state, nextBalance, { label, amount: amt, detail }), ok: true };
}
