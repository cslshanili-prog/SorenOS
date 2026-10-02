// Real Balance 錢包 —— 現金（總餘額）+ 若干張可互轉的銀行卡 + 一條共用流水；總覽的各 block 與 Net Worth 在 utils/finance.ts。
// 跟 utils/db.ts 的 BankTransaction（舊「存錢罐」經營遊戲的帳本）是兩套完全獨立的系統，字段名故意不撞。
import type { BankCard, RealBalanceState, RealBalanceTransaction } from '../types';
import { roundMoney } from './format';

/**
 * 錢包這一套（Real Balance、銀行卡、聊天轉帳、購物中心）顯示用的貨幣符號，只在這裡定義一次。
 * 麥當勞／瑞幸這類真實的大陸服務、API 計費說明不跟這個走，照舊是人民幣。
 */
export const MONEY_SYMBOL = '$';
/** 金額顯示成「$12.30」 */
export const formatMoney = (n: number): string => `${MONEY_SYMBOL}${n.toFixed(2)}`;

/**
 * 新錢包的起始餘額。2026-10 起改成 0（以前是 10000），要多少錢自己加或讓 AI 生成，
 * 見 plans/finance-wallet-design.md。已經建過帳戶的不受影響。
 */
export const REAL_BALANCE_SEED = 0;

export type RealBalanceResult = { state: RealBalanceState; ok: true } | { state: RealBalanceState; ok: false; reason: string };

let txSeq = 0;
const makeTxId = (): string => `rbtx-${Date.now()}-${(txSeq++).toString(36)}`;

/** 已經初始化過就原樣返回；沒有就生成空錢包（不落庫，調用方負責持久化）。 */
export function ensureRealBalanceState(state: RealBalanceState | undefined): RealBalanceState {
    if (state) return state;
    return { balance: REAL_BALANCE_SEED, cards: [], transactions: [] };
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
        label: '轉入帳戶', amount: amt, detail: `${card.name} 轉入帳戶 ${formatMoney(amt)}`, cardId, category: 'transfer',
    });
    return { state: next, ok: true };
}

/** Real Balance → 銀行卡（卡的「轉出帳戶」/頂部「提現」）。 */
export function transferBalanceToCard(state: RealBalanceState, cardId: string, amount: number): RealBalanceResult {
    const amt = roundMoney(amount);
    if (!(amt > 0)) return { state, ok: false, reason: '金額必須大於 0' };
    const card = state.cards.find(c => c.id === cardId);
    if (!card) return { state, ok: false, reason: '這張卡不存在' };
    if (state.balance < amt) return { state, ok: false, reason: '現金不夠' };
    const nextCards = state.cards.map(c => c.id === cardId ? { ...c, balance: roundMoney(c.balance + amt) } : c);
    const nextBalance = roundMoney(state.balance - amt);
    const next = pushTx({ ...state, cards: nextCards }, nextBalance, {
        label: '轉出帳戶', amount: -amt, detail: `${card.name} 轉出帳戶 ${formatMoney(amt)}`, cardId, category: 'transfer',
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
    // 聊天轉帳、紅包、購物會看到這句：新錢包從 0 開始，直接告訴人去哪補錢
    if (nextBalance < 0) return { state, ok: false, reason: '現金不夠：到 Real Balance 的「流水」記一筆收入，或從銀行卡轉入' };
    return { state: pushTx(state, nextBalance, { label, amount: amt, detail }), ok: true };
}
